import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { supabase } from '../db.js';

// Login e renovacao usam um cliente SEPARADO e descartavel: assim a sessao de um
// usuario nunca "contamina" o cliente principal (service_role) usado pelo backend.
const freshClient = () =>
  createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: ws },
  });

const httpError = (status, message) => Object.assign(new Error(message), { status });
const AGENT_FIELDS = 'id,name,email,role,active';

// ---------- verificacao de token (com cache curto) ----------

const cache = new Map(); // token -> { agent, exp }

export function invalidateAgent(agentId) {
  for (const [token, v] of cache) if (v.agent.id === agentId) cache.delete(token);
}

export async function agentFromToken(token) {
  if (!token) return null;
  const hit = cache.get(token);
  if (hit && hit.exp > Date.now()) return hit.agent;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;

  const { data: agent } = await supabase.from('agents').select(AGENT_FIELDS).eq('id', data.user.id).maybeSingle();
  if (!agent || !agent.active) return null;

  if (cache.size > 500) cache.clear();
  cache.set(token, { agent, exp: Date.now() + 30_000 });
  return agent;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Aceita: Authorization: Bearer <token do atendente>  OU  x-api-key (acesso admin tecnico)
export async function authenticate(req, res, next) {
  try {
    const header = req.get('authorization') || '';
    if (header.toLowerCase().startsWith('bearer ')) {
      const agent = await agentFromToken(header.slice(7).trim());
      if (!agent) return res.status(401).json({ error: 'sessao invalida ou expirada' });
      req.agent = agent;
      return next();
    }
    const key = req.get('x-api-key');
    if (key && process.env.FINLY_API_KEY && safeEqual(key, process.env.FINLY_API_KEY)) {
      req.agent = { id: null, name: 'API', role: 'admin', viaApiKey: true };
      return next();
    }
    return res.status(401).json({ error: 'nao autorizado' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

export function requireAdmin(req, res, next) {
  if (req.agent?.role !== 'admin') return res.status(403).json({ error: 'apenas administradores' });
  next();
}

// ---------- login ----------

async function agentIfAllowed(userId) {
  const { data } = await supabase.from('agents').select(AGENT_FIELDS).eq('id', userId).maybeSingle();
  return data && data.active ? data : null;
}

const sessionOf = (s) => ({ access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at });

export async function login(email, password) {
  const { data, error } = await freshClient().auth.signInWithPassword({ email, password });
  if (error || !data?.session) return { error: 'e-mail ou senha incorretos', status: 401 };

  const agent = await agentIfAllowed(data.user.id);
  if (!agent) return { error: 'este usuario nao tem acesso ao Finly. Fale com um administrador.', status: 403 };
  return { session: sessionOf(data.session), agent };
}

export async function refresh(refreshToken) {
  const { data, error } = await freshClient().auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data?.session) return { error: 'sessao expirada', status: 401 };

  const agent = await agentIfAllowed(data.user.id);
  if (!agent) return { error: 'sem acesso', status: 403 };
  return { session: sessionOf(data.session), agent };
}

// ---------- atendentes ----------

export async function createAgent({ name, email, password, role = 'agent' }) {
  name = String(name || '').trim().slice(0, 80);
  email = String(email || '').trim().toLowerCase();
  if (name.length < 2) throw httpError(400, 'informe o nome');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'e-mail invalido');
  if (String(password || '').length < 8) throw httpError(400, 'a senha precisa ter pelo menos 8 caracteres');
  if (!['admin', 'agent'].includes(role)) throw httpError(400, 'perfil invalido');

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name },
  });
  if (error) {
    const exists = /already|registered|exists/i.test(error.message);
    throw httpError(400, exists ? 'ja existe um usuario com este e-mail' : error.message);
  }

  const { data: agent, error: e2 } = await supabase
    .from('agents')
    .insert({ id: data.user.id, name, email, role })
    .select(AGENT_FIELDS)
    .single();
  if (e2) {
    await supabase.auth.admin.deleteUser(data.user.id);
    throw e2;
  }
  return agent;
}

async function findAuthUserByEmail(email) {
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) return null;
    const u = data.users.find((x) => (x.email || '').toLowerCase() === email);
    if (u) return u;
    if (data.users.length < 200) return null;
  }
  return null;
}

// Cria o primeiro administrador a partir das variaveis ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME.
// Depois que funcionar, apague ADMIN_PASSWORD do Railway.
// Esqueceu a senha? Defina ADMIN_RESET=true junto com ADMIN_PASSWORD e reinicie.
export async function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  const name = (process.env.ADMIN_NAME || 'Administrador').trim();
  if (!email) {
    console.warn('ADMIN_EMAIL nao definido: nenhum administrador sera criado automaticamente.');
    return;
  }

  const { data: existing } = await supabase.from('agents').select('id').eq('email', email).maybeSingle();
  if (existing) {
    if (process.env.ADMIN_RESET === 'true' && password.length >= 8) {
      await supabase.auth.admin.updateUserById(existing.id, { password });
      console.log('Senha do administrador redefinida (lembre de remover ADMIN_RESET e ADMIN_PASSWORD).');
    } else {
      console.log(`Administrador ${email} ja cadastrado.`);
    }
    return;
  }

  if (password.length < 8) {
    console.warn('ADMIN_PASSWORD ausente ou com menos de 8 caracteres: administrador nao criado.');
    return;
  }

  try {
    await createAgent({ name, email, password, role: 'admin' });
    console.log(`Administrador criado: ${email}`);
  } catch (e) {
    if (!/ja existe/.test(e.message)) throw e;
    // O usuario ja existe no Authentication: so falta o cadastro de atendente
    const user = await findAuthUserByEmail(email);
    if (!user) throw e;
    await supabase.auth.admin.updateUserById(user.id, { password });
    await supabase.from('agents').insert({ id: user.id, name, email, role: 'admin' });
    console.log(`Administrador vinculado: ${email}`);
  }
}
