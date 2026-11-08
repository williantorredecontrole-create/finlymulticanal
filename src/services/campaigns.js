import { supabase } from '../db.js';
import { getOrCreateConversation, resolveJid, sendMediaMessage, sendTextMessage } from './messaging.js';
import { downloadMedia } from './media.js';

// Motor de disparos. Roda dentro do proprio servidor: a cada 1 segundo olha as
// campanhas "running" e envia no maximo 1 mensagem por campanha, respeitando:
//  - delay aleatorio entre mensagens (min_delay_s a max_delay_s)
//  - limite diario (daily_limit)
//  - janela de horario (window_start a window_end, horario de Brasilia)
//  - so contatos com opt-in e que nao pediram para sair

const TZ = 'America/Sao_Paulo';
const nextAt = new Map(); // campanha -> proximo envio permitido (ms)
const failStreak = new Map(); // campanha -> falhas seguidas
const mediaCache = new Map(); // campanha -> { path, buffer } (baixa o anexo uma vez so)
let busy = false;

const rand = (a, b) => a + Math.random() * (b - a);

function brtHour() {
  const h = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: TZ }).format(new Date());
  return Number(h) % 24;
}

function brtDayStartISO() {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); // AAAA-MM-DD
  return new Date(`${ymd}T00:00:00-03:00`).toISOString();
}

// Texto da mensagem:
//  {Ola|Oi|Bom dia} -> sorteia uma das opcoes (varia o texto de cada envio)
//  {nome}           -> primeiro nome do contato
export function renderMessage(template, contact) {
  let t = String(template || '');
  t = t.replace(/\{([^{}|]+(?:\|[^{}]+)+)\}/g, (_m, opts) => {
    const list = opts.split('|');
    return list[Math.floor(Math.random() * list.length)];
  });
  let first = String(contact?.name || '').trim().split(/\s+/)[0] || '';
  // Planilhas costumam vir em MAIUSCULAS (ou minusculas): arruma para "Maria". Nomes ja bem escritos ficam como estao.
  if (first && (first === first.toUpperCase() || first === first.toLowerCase())) {
    first = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  } else if (first) {
    first = first.charAt(0).toUpperCase() + first.slice(1);
  }
  t = t.replace(/\{nome\}/gi, first);
  return t.replace(/[ \t]{2,}/g, ' ').replace(/ ([,.!?])/g, '$1').trim();
}

async function nextRecipient(campaignId) {
  const { data, error } = await supabase
    .from('campaign_recipients')
    .select('id, contact:contacts(id,name,phone,opt_in,opted_out)')
    .eq('campaign_id', campaignId)
    .eq('status', 'pending')
    .order('seq', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function markRecipient(id, status, error = null) {
  await supabase.from('campaign_recipients').update({ status, error }).eq('id', id);
}

async function campaignMedia(c) {
  const hit = mediaCache.get(c.id);
  if (hit && hit.path === c.media_path) return hit;
  const entry = { path: c.media_path, buffer: await downloadMedia(c.media_path) };
  mediaCache.set(c.id, entry);
  return entry;
}

async function sendOne(c, channel, recipient, contact, media) {
  const text = renderMessage(c.message_body, contact);
  try {
    // Confirma o endereco real do numero (com ou sem o nono digito). Sem WhatsApp = ignora.
    const jid = await resolveJid(channel, contact.phone);
    if (!jid) {
      await markRecipient(recipient.id, 'skipped', 'sem WhatsApp');
      nextAt.set(c.id, Date.now() + 2000); // so uma consulta a cada 2 s, sem esperar o delay inteiro
      return;
    }
    const conversation = await getOrCreateConversation(channel.id, jid, contact.id);
    // Com anexo, o texto vira a legenda do arquivo
    const msg = media
      ? await sendMediaMessage({
          channel,
          conversation,
          buffer: media.buffer,
          mime: c.media_mime,
          fileName: c.media_name,
          caption: text,
          campaignId: c.id,
          existingPath: c.media_path,
        })
      : await sendTextMessage({ channel, conversation, text, campaignId: c.id });

    // Se a entrega/leitura ja chegou pelo webhook, aproveita o status mais avancado
    const { data: m } = await supabase.from('messages').select('status').eq('id', msg.id).maybeSingle();
    const status = ['sent', 'delivered', 'read'].includes(m?.status) ? m.status : 'sent';

    await supabase
      .from('campaign_recipients')
      .update({ status, sent_at: new Date().toISOString(), message_id: msg.id, error: null })
      .eq('id', recipient.id);
    failStreak.set(c.id, 0);
  } catch (e) {
    await markRecipient(recipient.id, 'failed', String(e.message).slice(0, 300));
    const n = (failStreak.get(c.id) || 0) + 1;
    failStreak.set(c.id, n);
    if (n >= 3) {
      await supabase
        .from('campaigns')
        .update({
          status: 'paused',
          note: 'Pausada automaticamente: 3 falhas seguidas. Confira se o WhatsApp esta conectado e inicie de novo.',
        })
        .eq('id', c.id);
      failStreak.set(c.id, 0);
    }
  }
  // Delay aleatorio ate a proxima mensagem
  nextAt.set(c.id, Date.now() + rand(c.min_delay_s, c.max_delay_s) * 1000);
}

async function processCampaign(c) {
  if ((nextAt.get(c.id) || 0) > Date.now()) return;

  const hour = brtHour();
  if (hour < c.window_start || hour >= c.window_end) return; // fora do horario permitido

  const { count } = await supabase
    .from('campaign_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', c.id)
    .in('status', ['sent', 'delivered', 'read'])
    .gte('sent_at', brtDayStartISO());
  if ((count || 0) >= c.daily_limit) return; // limite do dia atingido; continua amanha

  const { data: channel } = await supabase.from('channels').select('*').eq('id', c.channel_id).maybeSingle();
  if (!channel) {
    await supabase.from('campaigns').update({ status: 'paused', note: 'Canal nao encontrado.' }).eq('id', c.id);
    return;
  }

  let media = null;
  if (c.media_path) {
    try {
      media = await campaignMedia(c);
    } catch (e) {
      await supabase
        .from('campaigns')
        .update({ status: 'paused', note: 'Nao foi possivel carregar o arquivo anexo: ' + e.message })
        .eq('id', c.id);
      return;
    }
  }

  // Contatos ignorados (sem opt-in, descadastrados, sem telefone) nao geram espera
  for (let i = 0; i < 50; i++) {
    const r = await nextRecipient(c.id);
    if (!r) {
      await supabase.from('campaigns').update({ status: 'done', note: null }).eq('id', c.id);
      nextAt.delete(c.id);
      return;
    }
    const contact = r.contact;
    if (!contact || !contact.phone) {
      await markRecipient(r.id, 'failed', 'sem telefone');
      continue;
    }
    if (contact.opted_out) {
      await markRecipient(r.id, 'skipped', 'descadastrado');
      continue;
    }
    if (!contact.opt_in) {
      await markRecipient(r.id, 'skipped', 'sem opt-in');
      continue;
    }
    await sendOne(c, channel, r, contact, media);
    return;
  }
}

export function startCampaignWorker() {
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const { data: running, error } = await supabase.from('campaigns').select('*').eq('status', 'running');
      if (error) throw error;
      for (const c of running || []) {
        try {
          await processCampaign(c);
        } catch (e) {
          console.error(`Campanha ${c.id}:`, e.message);
        }
      }
      // Libera da memoria o anexo de campanhas que nao estao mais rodando
      const ids = new Set((running || []).map((c) => c.id));
      for (const id of mediaCache.keys()) if (!ids.has(id)) mediaCache.delete(id);
    } catch (e) {
      console.error('Worker de campanhas:', e.message);
    } finally {
      busy = false;
    }
  }, 1000);
  console.log('Motor de campanhas ligado.');
}
