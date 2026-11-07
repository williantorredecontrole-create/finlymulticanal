import express, { Router } from 'express';
import { supabase } from '../db.js';
import { sendMediaMessage, sendTextMessage } from '../services/messaging.js';
import { MAX_BYTES, downloadMedia } from '../services/media.js';
import { requireAdmin, createAgent, invalidateAgent } from '../services/auth.js';
import { routeToTeam } from '../services/routing.js';

// Montado dentro de /api (ja autenticado: req.agent existe).
const router = Router();

const fail = (res, e, code) => res.status(code || e.status || 500).json({ error: e.message || String(e) });
const bad = (res, msg) => res.status(400).json({ error: msg });

const CONV_FIELDS =
  'id,status,unread_count,last_message_at,last_message_preview,assigned_to,channel_id,external_chat_id,' +
  'team_id,contact:contacts(name,phone),channel:channels(name,type),assignee:agents(id,name),team:teams(id,name)';

router.get('/me', (req, res) => res.json({ agent: req.agent }));

// ---------- conversas ----------

async function contactIdsMatching(q) {
  const digits = q.replace(/\D/g, '');
  const parts = [`name.ilike.%${q}%`];
  if (digits.length >= 3) parts.push(`phone.ilike.%${digits}%`);
  const { data, error } = await supabase.from('contacts').select('id').or(parts.join(',')).limit(200);
  if (error) throw error;
  return data.map((c) => c.id);
}

async function myTeamIds(agentId) {
  if (!agentId) return [];
  const { data } = await supabase.from('team_members').select('team_id').eq('agent_id', agentId);
  return (data || []).map((r) => r.team_id);
}

async function unreadConversations() {
  const { count } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'open')
    .gt('unread_count', 0);
  return count || 0;
}

// filter: all (abertas) | mine | unassigned | unread | closed      q: busca por nome/telefone
router.get('/inbox/conversations', async (req, res) => {
  try {
    const filter = String(req.query.filter || 'all');
    const q = String(req.query.q || '').replace(/[%,()*\\:]/g, ' ').trim().slice(0, 40);
    const unread = await unreadConversations();

    let query = supabase
      .from('conversations')
      .select(CONV_FIELDS)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(100);

    query = filter === 'closed' ? query.eq('status', 'closed') : query.eq('status', 'open');
    if (filter === 'mine') {
      if (!req.agent.id) return res.json({ items: [], unread_conversations: unread });
      query = query.eq('assigned_to', req.agent.id);
    }
    if (filter === 'unassigned') query = query.is('assigned_to', null);
    if (filter === 'unread') query = query.gt('unread_count', 0);

    // team: all | mine (minhas equipes) | none (sem equipe) | id de uma equipe
    const team = String(req.query.team || 'all');
    if (team === 'none') query = query.is('team_id', null);
    else if (team === 'mine') {
      const ids = await myTeamIds(req.agent.id);
      if (!ids.length) return res.json({ items: [], unread_conversations: unread });
      query = query.in('team_id', ids);
    } else if (team !== 'all' && /^[\w-]{1,64}$/.test(team)) query = query.eq('team_id', team);

    if (q) {
      const ids = await contactIdsMatching(q);
      if (!ids.length) return res.json({ items: [], unread_conversations: unread });
      query = query.in('contact_id', ids);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ items: data, unread_conversations: unread });
  } catch (e) {
    fail(res, e);
  }
});

async function getConversation(id) {
  const { data, error } = await supabase.from('conversations').select(CONV_FIELDS).eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

router.get('/inbox/conversations/:id', async (req, res) => {
  try {
    const conversation = await getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'conversa nao encontrada' });

    const { data, error } = await supabase
      .from('messages')
      .select(
        'id,direction,type,body,status,error,created_at,media_path,media_mime,media_name,media_size,sender:agents(name)'
      )
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;

    const messages = data.reverse().map(({ media_path, ...m }) => ({ ...m, has_media: !!media_path }));
    res.json({ conversation, messages });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/inbox/conversations/:id/read', async (req, res) => {
  try {
    const { error } = await supabase.from('conversations').update({ unread_count: 0 }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/inbox/conversations/:id/reply', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return bad(res, 'escreva a mensagem');
    if (text.length > 4000) return bad(res, 'mensagem muito longa (maximo 4000 caracteres)');

    const { data: conversation, error } = await supabase
      .from('conversations')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!conversation) return res.status(404).json({ error: 'conversa nao encontrada' });

    const { data: channel, error: e2 } = await supabase
      .from('channels')
      .select('*')
      .eq('id', conversation.channel_id)
      .single();
    if (e2) throw e2;

    const message = await sendTextMessage({ channel, conversation, text, sentBy: req.agent.id });

    // Quem responde primeiro assume a conversa
    if (!conversation.assigned_to && req.agent.id) {
      await supabase.from('conversations').update({ assigned_to: req.agent.id }).eq('id', conversation.id);
    }
    res.json({ ok: true, message });
  } catch (e) {
    fail(res, e);
  }
});

// ---------- midia ----------

const decode = (v) => {
  try {
    return decodeURIComponent(String(v || ''));
  } catch {
    return String(v || '');
  }
};

// Envio de arquivo: corpo = bytes do arquivo. Dados vao em cabecalhos:
// X-File-Type (tipo real), X-File-Name e X-Caption (codificados com encodeURIComponent).
const rawBody = express.raw({ type: () => true, limit: MAX_BYTES + 1024 });

router.post('/inbox/conversations/:id/media', rawBody, async (req, res) => {
  try {
    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || !buffer.length) return bad(res, 'arquivo vazio');
    if (buffer.length > MAX_BYTES) return res.status(413).json({ error: 'arquivo muito grande (maximo 20 MB)' });

    const mime =
      decode(req.get('x-file-type')).split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    const fileName = decode(req.get('x-file-name')).trim().slice(0, 120) || null;
    const caption = decode(req.get('x-caption')).trim().slice(0, 1000) || null;

    const { data: conversation, error } = await supabase
      .from('conversations')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!conversation) return res.status(404).json({ error: 'conversa nao encontrada' });

    const { data: channel, error: e2 } = await supabase
      .from('channels')
      .select('*')
      .eq('id', conversation.channel_id)
      .single();
    if (e2) throw e2;

    const message = await sendMediaMessage({
      channel,
      conversation,
      buffer,
      mime,
      fileName,
      caption,
      sentBy: req.agent.id,
    });

    if (!conversation.assigned_to && req.agent.id) {
      await supabase.from('conversations').update({ assigned_to: req.agent.id }).eq('id', conversation.id);
    }
    res.json({ ok: true, message });
  } catch (e) {
    fail(res, e);
  }
});

// Entrega o arquivo ao atendente logado. Tipos que o navegador executa viram download.
const INLINE_OK = /^(image\/(jpeg|png|gif|webp)|audio\/[\w.+-]+|video\/[\w.+-]+|application\/pdf)$/;

router.get('/media/:id', async (req, res) => {
  try {
    const { data: m, error } = await supabase
      .from('messages')
      .select('media_path,media_mime,media_name')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!m?.media_path) return res.status(404).json({ error: 'midia nao encontrada' });

    const buffer = await downloadMedia(m.media_path);
    const mime = m.media_mime || 'application/octet-stream';
    const inline = INLINE_OK.test(mime);
    res.set({
      'Content-Type': inline ? mime : 'application/octet-stream',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(m.media_name || 'arquivo')}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=86400',
    });
    res.send(buffer);
  } catch (e) {
    fail(res, e);
  }
});

// { agent_id: "uuid" } atribui; { agent_id: null } deixa sem atendente
router.post('/inbox/conversations/:id/assign', async (req, res) => {
  try {
    const agentId = req.body?.agent_id || null;
    if (agentId) {
      const { data: target } = await supabase.from('agents').select('id,active').eq('id', agentId).maybeSingle();
      if (!target || !target.active) return bad(res, 'atendente invalido ou inativo');
    }
    const { error } = await supabase.from('conversations').update({ assigned_to: agentId }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

// { team_id: "uuid" } envia para a equipe; { team_id: null } tira da equipe
router.post('/inbox/conversations/:id/team', async (req, res) => {
  try {
    const teamId = req.body?.team_id || null;
    const { data: conv, error } = await supabase
      .from('conversations')
      .select('id,assigned_to,team_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!conv) return res.status(404).json({ error: 'conversa nao encontrada' });

    if (!teamId) {
      const { error: e2 } = await supabase.from('conversations').update({ team_id: null }).eq('id', conv.id);
      if (e2) throw e2;
      return res.json({ ok: true, assigned_to: conv.assigned_to });
    }
    const r = await routeToTeam(conv, teamId);
    if (!r) return bad(res, 'equipe nao encontrada');
    res.json({ ok: true, assigned_to: r.assignedTo });
  } catch (e) {
    fail(res, e);
  }
});

// { status: "open" | "closed" }
router.post('/inbox/conversations/:id/status', async (req, res) => {
  try {
    const status = req.body?.status;
    if (!['open', 'closed'].includes(status)) return bad(res, 'status invalido');
    const { error } = await supabase.from('conversations').update({ status }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

// ---------- equipe ----------

router.get('/agents', async (req, res) => {
  try {
    const admin = req.agent.role === 'admin';
    let q = supabase
      .from('agents')
      .select(admin ? 'id,name,email,role,active,created_at' : 'id,name,role,active')
      .order('name');
    if (!admin) q = q.eq('active', true);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (e) {
    fail(res, e);
  }
});

router.post('/agents', requireAdmin, async (req, res) => {
  try {
    const agent = await createAgent(req.body || {});
    res.json({ ok: true, agent });
  } catch (e) {
    fail(res, e);
  }
});

// { name?, role?, active?, password? }
router.post('/agents/:id/update', requireAdmin, async (req, res) => {
  try {
    const { name, role, active, password } = req.body || {};
    const { data: target, error } = await supabase
      .from('agents')
      .select('id,role,active')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!target) return res.status(404).json({ error: 'atendente nao encontrado' });

    const patch = {};
    if (name !== undefined) {
      const n = String(name).trim().slice(0, 80);
      if (n.length < 2) return bad(res, 'nome muito curto');
      patch.name = n;
    }
    if (role !== undefined) {
      if (!['admin', 'agent'].includes(role)) return bad(res, 'perfil invalido');
      patch.role = role;
    }
    if (active !== undefined) patch.active = !!active;

    const losesAdmin =
      target.role === 'admin' && target.active && (patch.active === false || (patch.role && patch.role !== 'admin'));
    if (losesAdmin) {
      if (target.id === req.agent.id) return bad(res, 'voce nao pode remover o seu proprio acesso de administrador');
      const { count } = await supabase
        .from('agents')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'admin')
        .eq('active', true)
        .neq('id', target.id);
      if (!count) return bad(res, 'precisa existir pelo menos um administrador ativo');
    }

    if (password !== undefined) {
      if (String(password).length < 8) return bad(res, 'a senha precisa ter pelo menos 8 caracteres');
      const { error: e2 } = await supabase.auth.admin.updateUserById(target.id, { password: String(password) });
      if (e2) throw e2;
    }
    if (Object.keys(patch).length) {
      const { error: e3 } = await supabase.from('agents').update(patch).eq('id', target.id);
      if (e3) throw e3;
    }
    invalidateAgent(target.id);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

export default router;
