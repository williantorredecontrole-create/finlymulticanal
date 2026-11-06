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

export async function getChannelByInstance(instance) {
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
  const { data: conv } = await supabase
    .from('conversations')
    .select('unread_count')
    .eq('id', conversationId)
    .single();

  await supabase
    .from('conversations')
    .update({
      last_message_at: at.toISOString(),
      last_message_preview: (preview || '').slice(0, 120),
      unread_count: inbound ? (conv?.unread_count || 0) + 1 : 0,
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

// Envia texto e registra no banco. Reaproveitado depois pelos disparos.
export async function sendTextMessage({ channel, conversation, text, campaignId = null, sentBy = null }) {
  const { data: row, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      channel_id: channel.id,
      direction: 'out',
      type: 'text',
      body: text,
      status: 'queued',
      campaign_id: campaignId,
      ...(sentBy ? { sent_by: sentBy } : {}), // atendente que enviou (so quando houver)
    })
    .select()
    .single();
  if (error) throw error;

  try {
    const { externalId } = await evolution.sendText(channel.instance_name, conversation.external_chat_id, text);
    const messageId = externalId ? await finalizeOutbound(row, externalId) : row.id;
    await touchConversation(conversation.id, text, false);
    return { id: messageId, external_id: externalId, status: 'sent' };
  } catch (e) {
    await supabase
      .from('messages')
      .update({ status: 'failed', error: String(e.message).slice(0, 500) })
      .eq('id', row.id);
    throw e;
  }
}

// Envia imagem, video, audio ou documento: guarda no Storage, envia pela Evolution e registra.
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
}) {
  const kind = kindFromMime(mime);
  const name = fileName || defaultName(kind, mime);
  const path = existingPath || mediaPath(channel.id, conversation.id, name);
  if (!existingPath) await uploadMedia(path, buffer, mime);

  const text = kind === 'audio' ? null : caption || null; // audio nao tem legenda
  const { data: row, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      channel_id: channel.id,
      direction: 'out',
      type: kind,
      body: text,
      status: 'queued',
      media_path: path,
      media_mime: mime,
      media_name: name,
      media_size: buffer.length,
      ...(campaignId ? { campaign_id: campaignId } : {}),
      ...(sentBy ? { sent_by: sentBy } : {}),
    })
    .select()
    .single();
  if (error) throw error;

  try {
    const base64 = buffer.toString('base64');
    const target = conversation.external_chat_id;
    const { externalId } =
      kind === 'audio'
        ? await evolution.sendAudio(channel.instance_name, target, { mimetype: mime, base64 })
        : await evolution.sendMedia(channel.instance_name, target, {
            mediatype: kind,
            mimetype: mime,
            fileName: name,
            caption: text,
            base64,
          });
    const messageId = externalId ? await finalizeOutbound(row, externalId) : row.id;
    await touchConversation(conversation.id, previewFor(kind, text, name), false);
    return { id: messageId, external_id: externalId, status: 'sent' };
  } catch (e) {
    await supabase
      .from('messages')
      .update({ status: 'failed', error: String(e.message).slice(0, 500) })
      .eq('id', row.id);
    throw e;
  }
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
