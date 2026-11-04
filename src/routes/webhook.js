import { Router } from 'express';
import { supabase } from '../db.js';
import {
  getChannelByInstance,
  getOrCreateContact,
  getOrCreateConversation,
  saveMessage,
  updateMessageStatus,
} from '../services/messaging.js';

const router = Router();

const STATUS_MAP = {
  SERVER_ACK: 'sent',
  DELIVERY_ACK: 'delivered',
  READ: 'read',
  PLAYED: 'read',
  ERROR: 'failed',
};

const IGNORED_TYPES = ['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage'];

function extractText(m = {}) {
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    null
  );
}

async function handleUpsert(channel, m) {
  const key = m?.key;
  if (!key?.remoteJid || !key.id) return;

  const jid = key.remoteJid;
  if (jid.endsWith('@g.us') || jid.includes('broadcast')) return; // ignora grupos e status

  const messageType = m.messageType || '';
  if (IGNORED_TYPES.includes(messageType)) return;

  // Telefone real (quando o WhatsApp manda o identificador "lid", usa o alternativo se existir)
  const phoneJid = [jid, key.remoteJidAlt].find((j) => j && j.endsWith('@s.whatsapp.net'));
  const phone = phoneJid ? phoneJid.split('@')[0].replace(/\D/g, '') : null;

  const fromMe = !!key.fromMe;
  const contact = await getOrCreateContact({ phone, name: fromMe ? null : m.pushName });
  const conversation = await getOrCreateConversation(channel.id, jid, contact?.id || null);

  const text = extractText(m.message);
  const type = text ? 'text' : messageType.replace('Message', '') || 'other';
  const body = text || `[${type}]`;

  const raw = Number(m.messageTimestamp?.low ?? m.messageTimestamp);
  const timestamp = Number.isFinite(raw) && raw > 0 ? new Date(raw * 1000) : new Date();

  await saveMessage({
    channel,
    conversation,
    direction: fromMe ? 'out' : 'in',
    type,
    body,
    externalId: key.id,
    timestamp,
  });
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
