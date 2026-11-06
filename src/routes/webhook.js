import { Router } from 'express';
import { supabase } from '../db.js';
import {
  canonicalPhone,
  getChannelByInstance,
  getOrCreateContact,
  getOrCreateConversation,
  isOptOut,
  saveMessage,
  sendTextMessage,
  updateMessageStatus,
} from '../services/messaging.js';
import { MAX_INBOUND_BYTES, MEDIA_TYPES, fetchInboundMedia, previewFor } from '../services/media.js';

const router = Router();

const STATUS_MAP = {
  SERVER_ACK: 'sent',
  DELIVERY_ACK: 'delivered',
  READ: 'read',
  PLAYED: 'read',
  ERROR: 'failed',
};

const IGNORED_TYPES = ['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage'];

// Mensagens "embrulhadas" (temporarias, visualizacao unica, documento com legenda)
const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
];

function unwrap(message) {
  let cur = message;
  for (let i = 0; i < 4 && cur; i++) {
    const w = WRAPPERS.find((k) => cur[k]?.message);
    if (!w) break;
    cur = cur[w].message;
  }
  return cur || {};
}

function extractText(msg = {}) {
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.buttonsResponseMessage?.selectedDisplayText ||
    msg.listResponseMessage?.title ||
    msg.templateButtonReplyMessage?.selectedDisplayText ||
    null
  );
}

const sizeOf = (node) => Number(node?.fileLength?.low ?? node?.fileLength) || 0;

async function handleUpsert(channel, m) {
  const key = m?.key;
  if (!key?.remoteJid || !key.id) return;

  const jid = key.remoteJid;
  if (jid.endsWith('@g.us') || jid.includes('broadcast')) return; // ignora grupos e status

  const messageType = m.messageType || '';
  if (IGNORED_TYPES.includes(messageType)) return;

  const msg = unwrap(m.message);
  const mediaKey = Object.keys(MEDIA_TYPES).find((k) => msg[k]);
  const caption = extractText(msg);

  // Mensagem sem conteudo util (so metadados): ignora
  if (!mediaKey && !caption && Object.keys(msg).every((k) => k === 'messageContextInfo')) return;

  // Telefone real (quando o WhatsApp manda o identificador "lid", usa o alternativo se existir)
  const phoneJid = [jid, key.remoteJidAlt].find((j) => j && j.endsWith('@s.whatsapp.net'));
  const phone = phoneJid ? canonicalPhone(phoneJid.split('@')[0].replace(/\D/g, '')) : null;

  const fromMe = !!key.fromMe;
  const contact = await getOrCreateContact({ phone, name: fromMe ? null : m.pushName });
  const conversation = await getOrCreateConversation(channel.id, jid, contact?.id || null);

  let type;
  let body;
  let preview;
  let tooBig = false;
  if (mediaKey) {
    const node = msg[mediaKey];
    type = MEDIA_TYPES[mediaKey].type;
    tooBig = sizeOf(node) > MAX_INBOUND_BYTES;
    body = caption || (tooBig ? '[arquivo grande demais para exibir aqui]' : null);
    preview = previewFor(type, caption, node.fileName);
  } else if (caption) {
    type = 'text';
    body = caption;
    preview = caption;
  } else {
    type = messageType.replace('Message', '') || 'outro';
    body = `[${type}]`;
    preview = body;
  }

  const raw = Number(m.messageTimestamp?.low ?? m.messageTimestamp);
  const timestamp = Number.isFinite(raw) && raw > 0 ? new Date(raw * 1000) : new Date();

  const saved = await saveMessage({
    channel,
    conversation,
    direction: fromMe ? 'out' : 'in',
    type,
    body,
    preview,
    externalId: key.id,
    timestamp,
  });
  if (!saved) return; // ja existia

  // Baixa a midia em segundo plano. Se fomos nos que enviamos pelo painel, espera um pouco
  // para a mensagem do painel assumir o registro antes de baixar de novo.
  if (mediaKey && !tooBig) {
    setTimeout(() => {
      fetchInboundMedia({
        channel,
        messageId: saved.id,
        conversationId: conversation.id,
        type,
        key,
        rawMessage: m.message,
      }).catch((e) => console.error('Midia nao baixada:', e.message));
    }, fromMe ? 8000 : 0);
  }

  // Descadastro automatico: o contato responde SAIR / PARAR
  if (!mediaKey && !fromMe && contact && caption && isOptOut(caption)) {
    await supabase.from('contacts').update({ opted_out: true }).eq('id', contact.id);
    try {
      await sendTextMessage({
        channel,
        conversation,
        text: 'Pronto! Você não receberá mais mensagens nossas.',
      });
    } catch (e) {
      console.error('Falha ao confirmar descadastro:', e.message);
    }
  }
}

async function handleEvent(payload) {
  const event = String(payload?.event || '').toLowerCase().replace(/_/g, '.');
  const instance = payload?.instance || payload?.instanceName;
  if (!event || !instance) return;

  const channel = await getChannelByInstance(instance);
  const list = Array.isArray(payload.data) ? payload.data : [payload.data];

  if (event === 'connection.update') {
    const state = payload.data?.state;
    if (state) {
      const status = state === 'open' ? 'connected' : state === 'connecting' ? 'connecting' : 'disconnected';
      await supabase.from('channels').update({ status }).eq('id', channel.id);
    }
    return;
  }

  if (event === 'messages.upsert') {
    for (const m of list) await handleUpsert(channel, m);
    return;
  }

  if (event === 'messages.update') {
    for (const u of list) {
      const id = u?.keyId || u?.key?.id || u?.messageId;
      const status = STATUS_MAP[String(u?.status || '').toUpperCase()];
      if (id && status) await updateMessageStatus(channel.id, id, status);
    }
  }
}

// URL configurada na Evolution: /webhook/evolution?secret=SEU_WEBHOOK_SECRET
router.post('/evolution', (req, res) => {
  if (!process.env.WEBHOOK_SECRET || req.query.secret !== process.env.WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }
  res.sendStatus(200); // responde rapido; processa em seguida
  handleEvent(req.body).catch((e) => console.error('Erro no webhook:', e));
});

export default router;
