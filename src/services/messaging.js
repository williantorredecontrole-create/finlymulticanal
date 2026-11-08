import { supabase } from '../db.js';
import * as evolution from '../adapters/evolution.js';
import { defaultName, kindFromMime, mediaPath, previewFor, uploadMedia } from './media.js';

// ---------- utilidades ----------

// Deixa so digitos, acrescenta 55 (Brasil) se vier sem codigo do pais e guarda sempre
// o celular com o nono digito (ex.: 556192273131 -> 5561992273131).
export function normalizePhone(value) {
  let d = String(value || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return canonicalPhone(d);
}

// Celular antigo do Brasil (8 digitos comecando em 6-9) ganhou um 9 na frente.
export function canonicalPhone(d) {
  d = String(d || '');
  if (d.startsWith('55') && d.length === 12 && /[6-9]/.test(d[4])) return d.slice(0, 4) + '9' + d.slice(4);
  return d;
}

// Muitas contas antigas estao registradas no WhatsApp SEM o nono digito: testamos as duas formas.
export function brVariants(phone) {
  if (phone.startsWith('55') && phone.length === 13 && phone[4] === '9') {
    return [phone, phone.slice(0, 4) + phone.slice(5)];
  }
  return [phone];
}

// Descobre o endereco real (JID) do numero no WhatsApp. Devolve null se a pessoa nao tem WhatsApp.
// Se a consulta em si falhar (Evolution fora do ar), lanca erro: nao e o mesmo que "nao tem WhatsApp".
export async function resolveJid(channel, phone) {
  const results = await evolution.checkNumbers(channel.instance_name, brVariants(phone));
  const hit = results.find((r) => r?.exists && r.jid);
  return hit ? hit.jid : null;
}

// ---------- canais ----------

const channelCache = new Map(); // instancia -> { channel, exp }

export async function getChannelByInstance(instance) {
  const hit = channelCache.get(instance);
  if (hit && hit.exp > Date.now()) return hit.channel;
  const channel = await loadChannelByInstance(instance);
  channelCache.set(instance, { channel, exp: Date.now() + 60_000 });
  return channel;
}

async function loadChannelByInstance(instance) {
  const { data, error } = await supabase
    .from('channels')
    .select('*')
    .eq('driver', 'evolution_baileys')
    .eq('instance_name', instance)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (data) return data;

  const { data: created, error: e2 } = await supabase
    .from('channels')
    .insert({
      name: instance,
      type: 'whatsapp',
      driver: 'evolution_baileys',
      instance_name: instance,
      status: 'connected',
    })
    .select()
    .single();
  if (e2) throw e2;
  return created;
}

// ---------- contatos e conversas ----------

export async function getOrCreateContact({ phone, name }) {
  if (!phone) return null;

  const { data: found, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('phone', phone)
    .maybeSingle();
  if (error) throw error;

  if (found) {
    if (!found.name && name) {
      await supabase.from('contacts').update({ name }).eq('id', found.id);
      found.name = name;
    }
    return found;
  }

  const { data, error: e2 } = await supabase
    .from('contacts')
    .insert({ phone, name: name || null })
    .select()
    .single();
  if (e2) throw e2;
  return data;
}

export async function getOrCreateConversation(channelId, jid, contactId) {
  const { data: found, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('channel_id', channelId)
    .eq('external_chat_id', jid)
    .maybeSingle();
  if (error) throw error;

  if (found) {
    if (!found.contact_id && contactId) {
      await supabase.from('conversations').update({ contact_id: contactId }).eq('id', found.id);
      found.contact_id = contactId;
    }
    return found;
  }

  const { data, error: e2 } = await supabase
    .from('conversations')
    .insert({ channel_id: channelId, external_chat_id: jid, contact_id: contactId || null })
    .select()
    .single();
  if (e2) throw e2;
  return data;
}

async function touchConversation(conversationId, preview, inbound, at = new Date()) {
  let unread = 0;
  if (inbound) {
    // mensagem recebida: soma 1 ao contador de nao lidas (enviar zera, sem precisar consultar)
    const { data: conv } = await supabase.from('conversations').select('unread_count').eq('id', conversationId).single();
    unread = (conv?.unread_count || 0) + 1;
  }
  await supabase
    .from('conversations')
    .update({
      last_message_at: at.toISOString(),
      last_message_preview: (preview || '').slice(0, 120),
      unread_count: unread,
      status: 'open',
    })
    .eq('id', conversationId);
}

// ---------- mensagens recebidas (via webhook) ----------

// Salva uma mensagem vinda do webhook. Retorna null se ja existia (duplicada).
export async function saveMessage({ channel, conversation, direction, type, body, preview, externalId, timestamp }) {
  const { data, error } = await supabase
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        channel_id: channel.id,
        direction,
        type,
        body,
        external_id: externalId,
        status: direction === 'in' ? 'received' : 'sent',
        sent_at: timestamp.toISOString(),
        created_at: timestamp.toISOString(),
      },
      { onConflict: 'channel_id,external_id', ignoreDuplicates: true }
    )
    .select();
  if (error) throw error;
  if (!data || data.length === 0) return null;

  await touchConversation(conversation.id, preview ?? body, direction === 'in', timestamp);
  return data[0];
}

const RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };

// Atualiza entregue/lida sem nunca "voltar" de status.
export async function updateMessageStatus(channelId, externalId, status) {
  const { data: cur } = await supabase
    .from('messages')
    .select('id,status')
    .eq('channel_id', channelId)
    .eq('external_id', externalId)
    .maybeSingle();
  if (!cur) return;

  if (status !== 'failed' && (RANK[status] ?? -1) <= (RANK[cur.status] ?? 0)) return;

  await supabase.from('messages').update({ status }).eq('id', cur.id);
  await supabase.from('campaign_recipients').update({ status }).eq('message_id', cur.id);
}

// ---------- envio ----------

// Campos que so o painel conhece e que precisam sobreviver se o webhook chegar primeiro
const MERGE_FIELDS = ['campaign_id', 'sent_by', 'media_path', 'media_mime', 'media_name', 'media_size'];

async function finalizeOutbound(row, externalId) {
  const { error } = await supabase
    .from('messages')
    .update({ external_id: externalId, status: 'sent', sent_at: new Date().toISOString() })
    .eq('id', row.id);

  // 23505 = o webhook ja registrou essa mesma mensagem antes de terminarmos.
  // Mantemos a do webhook, copiamos o que so nos sabemos e removemos a duplicada.
  if (error && error.code === '23505') {
    const { data: existing } = await supabase
      .from('messages')
      .select('id,body')
      .eq('channel_id', row.channel_id)
      .eq('external_id', externalId)
      .maybeSingle();
    if (existing) {
      const patch = {};
      for (const f of MERGE_FIELDS) if (row[f] != null) patch[f] = row[f];
      if (row.body && !existing.body) patch.body = row.body;
      if (Object.keys(patch).length) await supabase.from('messages').update(patch).eq('id', existing.id);
      await supabase.from('messages').delete().eq('id', row.id);
      return existing.id;
    }
  } else if (error) {
    throw error;
  }
  return row.id;
}

// Envia texto e registra no banco. Grava e envia AO MESMO TEMPO e termina o resto em paralelo,
// para o atendente nao esperar varias idas e voltas ao banco.
//  afterSend: tarefa extra (ex.: assumir a conversa) que roda junto com o fechamento do registro.
//  delay: tempo de "digitando..." na Evolution (use 0 em respostas de atendentes).
export async function sendTextMessage({ channel, conversation, text, campaignId = null, sentBy = null, delay, afterSend = null, deferBookkeeping = false }) {
  const t0 = Date.now();
  const base = {
    conversation_id: conversation.id,
    channel_id: channel.id,
    direction: 'out',
    type: 'text',
    body: text,
    campaign_id: campaignId,
    ...(sentBy ? { sent_by: sentBy } : {}), // atendente que enviou (so quando houver)
  };

  const insertP = supabase.from('messages').insert({ ...base, status: 'queued' }).select().single();
  const sendP = (async () => {
    const s = Date.now();
    const r = await evolution.sendText(channel.instance_name, conversation.external_chat_id, text, { delay });
    r.ms = Date.now() - s;
    return r;
  })();
  const [ins, snd] = await Promise.allSettled([insertP, sendP]);

  const insertError = ins.status === 'rejected' ? ins.reason : ins.value.error;
  let row = insertError ? null : ins.value.data;

  if (snd.status === 'rejected') {
    if (row) {
      await supabase
        .from('messages')
        .update({ status: 'failed', error: String(snd.reason.message).slice(0, 500) })
        .eq('id', row.id);
    }
    throw snd.reason;
  }

  const { externalId, ms: evolutionMs } = snd.value;

  // Enviou, mas nao conseguiu gravar antes: grava agora (a mensagem ja foi para o cliente)
  if (!row) {
    console.error('Mensagem enviada, mas o registro falhou; tentando de novo:', insertError?.message);
    const { data, error } = await supabase
      .from('messages')
      .insert({ ...base, status: 'sent', external_id: externalId, sent_at: new Date().toISOString() })
      .select()
      .single();
    if (error) console.error('Nao foi possivel registrar a mensagem enviada:', error.message);
    row = data || null;
  }

  const finish = () =>
    Promise.all([
      row && externalId ? finalizeOutbound(row, externalId) : row?.id ?? null,
      touchConversation(conversation.id, text, false),
      afterSend ? Promise.resolve().then(afterSend).catch((e) => console.error('Pos-envio:', e.message)) : null,
    ]);

  // Respostas de atendentes: a mensagem ja saiu, entao responde agora e fecha o registro logo em seguida
  if (deferBookkeeping) {
    finish().catch((e) => console.error('Fechamento do registro:', e.message));
    console.log(`[envio] texto total=${Date.now() - t0}ms evolution=${evolutionMs}ms (registro fecha em seguida)`);
    return { id: row?.id ?? null, external_id: externalId, status: 'sent' };
  }

  const [messageId] = await finish();
  console.log(`[envio] texto total=${Date.now() - t0}ms evolution=${evolutionMs}ms`);
  return { id: messageId, external_id: externalId, status: 'sent' };
}

// Envia imagem, video, audio ou documento: guarda no Storage, envia pela Evolution e registra.
// Guardar o arquivo, gravar o registro e enviar acontecem ao mesmo tempo.
export async function sendMediaMessage({
  channel,
  conversation,
  buffer,
  mime,
  fileName,
  caption = null,
  sentBy = null,
  campaignId = null,
  existingPath = null, // campanhas: o arquivo ja esta no Storage, nao guarda uma copia por contato
  afterSend = null,
}) {
  const t0 = Date.now();
  const kind = kindFromMime(mime);
  const name = fileName || defaultName(kind, mime);
  const path = existingPath || mediaPath(channel.id, conversation.id, name);
  const text = kind === 'audio' ? null : caption || null; // audio nao tem legenda

  const base = {
    conversation_id: conversation.id,
    channel_id: channel.id,
    direction: 'out',
    type: kind,
    body: text,
    media_path: path,
    media_mime: mime,
    media_name: name,
    media_size: buffer.length,
    ...(campaignId ? { campaign_id: campaignId } : {}),
    ...(sentBy ? { sent_by: sentBy } : {}),
  };

  const insertP = supabase.from('messages').insert({ ...base, status: 'queued' }).select().single();
  const uploadP = existingPath ? Promise.resolve() : uploadMedia(path, buffer, mime);
  const sendP = (async () => {
    const s = Date.now();
    const base64 = buffer.toString('base64');
    const target = conversation.external_chat_id;
    const r =
      kind === 'audio'
        ? await evolution.sendAudio(channel.instance_name, target, { mimetype: mime, base64 })
        : await evolution.sendMedia(channel.instance_name, target, {
            mediatype: kind,
            mimetype: mime,
            fileName: name,
            caption: text,
            base64,
          });
    r.ms = Date.now() - s;
    return r;
  })();
  const [ins, upl, snd] = await Promise.allSettled([insertP, uploadP, sendP]);

  const insertError = ins.status === 'rejected' ? ins.reason : ins.value.error;
  let row = insertError ? null : ins.value.data;
  const uploadFailed = upl.status === 'rejected';

  if (snd.status === 'rejected') {
    if (row) {
      await supabase
        .from('messages')
        .update({ status: 'failed', error: String(snd.reason.message).slice(0, 500) })
        .eq('id', row.id);
    }
    throw snd.reason;
  }

  const { externalId, ms: evolutionMs } = snd.value;

  if (uploadFailed) console.error('Midia enviada, mas nao foi guardada no Storage:', upl.reason?.message);
  if (!row) {
    console.error('Midia enviada, mas o registro falhou; tentando de novo:', insertError?.message);
    const { data, error } = await supabase
      .from('messages')
      .insert({
        ...base,
        ...(uploadFailed ? { media_path: null } : {}),
        status: 'sent',
        external_id: externalId,
        sent_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) console.error('Nao foi possivel registrar a midia enviada:', error.message);
    row = data || null;
  } else if (uploadFailed) {
    await supabase.from('messages').update({ media_path: null }).eq('id', row.id);
    row.media_path = null;
  }

  const [messageId] = await Promise.all([
    row && externalId ? finalizeOutbound(row, externalId) : row?.id ?? null,
    touchConversation(conversation.id, previewFor(kind, text, name), false),
    afterSend ? Promise.resolve().then(afterSend).catch((e) => console.error('Pos-envio:', e.message)) : null,
  ]);
  console.log(`[envio] midia(${kind}) total=${Date.now() - t0}ms evolution=${evolutionMs}ms`);
  return { id: messageId, external_id: externalId, status: 'sent' };
}

// ---------- descadastro ----------

const OPT_OUT_WORDS = ['sair', 'parar', 'stop', 'cancelar', 'descadastrar', 'remover', 'nao quero receber'];

// True se a mensagem inteira for um pedido de saida (ex: "SAIR", "Parar!", "não quero receber")
export function isOptOut(text) {
  const t = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z ]/g, '')
    .trim();
  return OPT_OUT_WORDS.includes(t);
}
