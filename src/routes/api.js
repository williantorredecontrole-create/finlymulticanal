import { Router } from 'express';
import { supabase } from '../db.js';
import {
  normalizePhone,
  getOrCreateContact,
  getOrCreateConversation,
  resolveJid,
  sendTextMessage,
} from '../services/messaging.js';
import campaignsRouter from './campaigns.js';
import inboxRouter from './inbox.js';
import teamsRouter from './teams.js';
import { authenticate, requireAdmin } from '../services/auth.js';

const router = Router();

// Protecao: so com login (Authorization: Bearer <token da sessao>)
router.use(authenticate);

async function pickChannel(channelId) {
  let q = supabase.from('channels').select('*').eq('driver', 'evolution_baileys');
  if (channelId) q = q.eq('id', channelId);
  const { data, error } = await q.order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (error) throw error;
  return data;
}

const fail = (res, e) => res.status(500).json({ error: e.message || String(e) });

router.get('/channels', async (_req, res) => {
  const { data, error } = await supabase.from('channels').select('*').order('created_at');
  if (error) return fail(res, error);
  res.json(data);
});

router.get('/conversations', async (_req, res) => {
  const { data, error } = await supabase
    .from('conversations')
    .select('*, contact:contacts(name,phone), channel:channels(name,type)')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(50);
  if (error) return fail(res, error);
  res.json(data);
});

router.get('/conversations/:id/messages', async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('id,direction,type,body,status,created_at')
    .eq('conversation_id', req.params.id)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) return fail(res, error);
  res.json(data);
});

// Enviar para um numero: { "number": "62999999999", "text": "Ola" }
router.post('/send', async (req, res) => {
  try {
    const { number, text, channel_id } = req.body || {};
    if (!number || !text) return res.status(400).json({ error: 'informe number e text' });

    const channel = await pickChannel(channel_id);
    if (!channel) return res.status(400).json({ error: 'nenhum canal cadastrado (defina EVOLUTION_INSTANCE)' });

    const phone = normalizePhone(number);
    const jid = await resolveJid(channel, phone);
    if (!jid) return res.status(400).json({ error: 'este numero nao tem WhatsApp' });
    const contact = await getOrCreateContact({ phone });
    const conversation = await getOrCreateConversation(channel.id, jid, contact.id);
    const message = await sendTextMessage({ channel, conversation, text });
    res.json({ ok: true, message });
  } catch (e) {
    fail(res, e);
  }
});

// Responder dentro de uma conversa: { "text": "Ola" }
router.post('/conversations/:id/reply', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'informe text' });

    const { data: conversation, error } = await supabase
      .from('conversations')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;

    const { data: channel, error: e2 } = await supabase
      .from('channels')
      .select('*')
      .eq('id', conversation.channel_id)
      .single();
    if (e2) throw e2;

    const message = await sendTextMessage({ channel, conversation, text });
    res.json({ ok: true, message });
  } catch (e) {
    fail(res, e);
  }
});

router.use(inboxRouter);
router.use(teamsRouter);
// Contatos e campanhas: somente administradores
router.use(requireAdmin, campaignsRouter);

export default router;
