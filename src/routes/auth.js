import { Router } from 'express';
import { login, refresh } from '../services/auth.js';

const router = Router();

// Limite de tentativas: 8 erros por IP+e-mail a cada 15 minutos
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;
const fails = new Map(); // chave -> { n, reset }

function blocked(key) {
  const f = fails.get(key);
  if (!f) return false;
  if (f.reset < Date.now()) {
    fails.delete(key);
    return false;
  }
  return f.n >= MAX_FAILS;
}

function registerFail(key) {
  const f = fails.get(key);
  if (!f || f.reset < Date.now()) fails.set(key, { n: 1, reset: Date.now() + WINDOW_MS });
  else f.n++;
  if (fails.size > 2000) fails.clear();
}

router.post('/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'informe e-mail e senha' });

    const key = `${req.ip}|${email}`;
    if (blocked(key)) return res.status(429).json({ error: 'muitas tentativas. Tente novamente em 15 minutos.' });

    const r = await login(email, password);
    if (r.error) {
      if (r.status === 401) registerFail(key);
      return res.status(r.status || 401).json({ error: r.error });
    }
    fails.delete(key);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const token = String(req.body?.refresh_token || '');
    if (!token) return res.status(400).json({ error: 'refresh_token ausente' });
    const r = await refresh(token);
    if (r.error) return res.status(r.status || 401).json({ error: r.error });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
