import express, { Router } from 'express';
import { supabase } from '../db.js';
import { normalizePhone } from '../services/messaging.js';
import { MAX_BYTES, defaultName, kindFromMime, mediaPath, uploadMedia } from '../services/media.js';

// Estas rotas sao montadas dentro de /api (ja protegidas pela x-api-key).
const router = Router();

const fail = (res, e, code = 500) => res.status(code).json({ error: e.message || String(e) });
const bad = (res, msg) => res.status(400).json({ error: msg });

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

const clamp = (v, min, max, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

// ---------- contatos ----------

router.get('/contacts/summary', async (_req, res) => {
  try {
    const count = async (build) => {
      const { count: n, error } = await build(supabase.from('contacts').select('id', { count: 'exact', head: true }));
      if (error) throw error;
      return n || 0;
    };
    const total = await count((q) => q);
    const optIn = await count((q) => q.eq('opt_in', true).eq('opted_out', false));
    const optedOut = await count((q) => q.eq('opted_out', true));
    res.json({ total, opt_in: optIn, opted_out: optedOut });
  } catch (e) {
    fail(res, e);
  }
});

// { contacts: [{name, phone}], opt_in: true/false, tag: "texto" }
router.post('/contacts/import', async (req, res) => {
  try {
    const { contacts = [], opt_in = false, tag = '' } = req.body || {};
    if (!Array.isArray(contacts) || !contacts.length) return bad(res, 'envie a lista "contacts"');
    if (contacts.length > 5000) return bad(res, 'maximo de 5000 contatos por importacao');

    const map = new Map();
    let invalid = 0;
    for (const c of contacts) {
      const phone = normalizePhone(c?.phone);
      if (phone.length < 12 || phone.length > 15) {
        invalid++;
        continue;
      }
      if (!map.has(phone)) map.set(phone, { phone, name: String(c?.name || '').trim().slice(0, 100) || null });
    }

    const phones = [...map.keys()];
    const existing = new Map();
    for (const part of chunk(phones, 200)) {
      const { data, error } = await supabase
        .from('contacts')
        .select('id,phone,name,tags,opt_in,opted_out')
        .in('phone', part);
      if (error) throw error;
      for (const r of data) existing.set(r.phone, r);
    }

    const now = new Date().toISOString();
    const cleanTag = String(tag || '').trim().toLowerCase().slice(0, 40);
    const toInsert = [];
    let updated = 0;

    for (const [phone, c] of map) {
      const ex = existing.get(phone);
      if (!ex) {
        toInsert.push({
          phone,
          name: c.name,
          opt_in: !!opt_in,
          opt_in_at: opt_in ? now : null,
          tags: cleanTag ? [cleanTag] : [],
        });
        continue;
      }
      // Quem pediu para sair nunca volta a receber por importacao
      const patch = {};
      if (!ex.name && c.name) patch.name = c.name;
      if (opt_in && !ex.opt_in && !ex.opted_out) {
        patch.opt_in = true;
        patch.opt_in_at = now;
      }
      if (cleanTag && !(ex.tags || []).includes(cleanTag)) patch.tags = [...(ex.tags || []), cleanTag];
      if (Object.keys(patch).length) {
        const { error } = await supabase.from('contacts').update(patch).eq('id', ex.id);
        if (error) throw error;
        updated++;
      }
    }

    for (const part of chunk(toInsert, 500)) {
      const { error } = await supabase.from('contacts').insert(part);
      if (error) throw error;
    }

    const optedOutIgnored = [...existing.values()].filter((e) => e.opted_out).length;
    res.json({
      ok: true,
      total: phones.length,
      inserted: toInsert.length,
      updated,
      invalid,
      opted_out_ignored: optedOutIgnored,
    });
  } catch (e) {
    fail(res, e);
  }
});

// ---------- campanhas ----------

router.get('/campaigns', async (_req, res) => {
  try {
    const { data: camps, error } = await supabase
      .from('campaigns')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) throw error;

    const stats = {};
    const ids = camps.map((c) => c.id);
    if (ids.length) {
      const { data: st, error: e2 } = await supabase.from('campaign_stats').select('*').in('campaign_id', ids);
      if (e2) throw e2;
      for (const s of st || []) stats[s.campaign_id] = s;
    }
    const empty = { total: 0, pending: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 };
    res.json(camps.map((c) => ({ ...c, stats: stats[c.id] || empty })));
  } catch (e) {
    fail(res, e);
  }
});

router.post('/campaigns', async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const messageBody = String(b.message_body || '').trim();
    if (!name || !messageBody) return bad(res, 'informe name e message_body');

    const minDelay = clamp(b.min_delay_s, 3, 600, 10);
    const maxDelay = Math.max(minDelay, clamp(b.max_delay_s, 3, 1200, 30));
    const dailyLimit = clamp(b.daily_limit, 1, 5000, 150);
    const windowStart = clamp(b.window_start, 0, 23, 8);
    const windowEnd = clamp(b.window_end, 1, 24, 20);
    if (windowEnd <= windowStart) return bad(res, 'o horario final deve ser maior que o inicial');

    let chQuery = supabase.from('channels').select('*').eq('driver', 'evolution_baileys');
    if (b.channel_id) chQuery = chQuery.eq('id', b.channel_id);
    const { data: channel, error: eCh } = await chQuery.order('created_at').limit(1).maybeSingle();
    if (eCh) throw eCh;
    if (!channel) return bad(res, 'nenhum canal encontrado');

    const { data: camp, error } = await supabase
      .from('campaigns')
      .insert({
        name,
        channel_id: channel.id,
        message_body: messageBody,
        min_delay_s: minDelay,
        max_delay_s: maxDelay,
        daily_limit: dailyLimit,
        window_start: windowStart,
        window_end: windowEnd,
        status: 'draft',
      })
      .select()
      .single();
    if (error) throw error;

    // Destinatarios: so contatos com opt-in que nao pediram para sair (e etiqueta, se informada)
    const tag = String(b.tag || '').trim().toLowerCase();
    let from = 0;
    let added = 0;
    for (;;) {
      let q = supabase
        .from('contacts')
        .select('id')
        .eq('opt_in', true)
        .eq('opted_out', false)
        .not('phone', 'is', null)
        .order('id')
        .range(from, from + 999);
      if (tag) q = q.contains('tags', [tag]);
      const { data, error: eC } = await q;
      if (eC) throw eC;
      if (!data.length) break;

      const rows = data.map((c) => ({ campaign_id: camp.id, contact_id: c.id }));
      for (const part of chunk(rows, 500)) {
        const { error: eR } = await supabase.from('campaign_recipients').insert(part);
        if (eR) throw eR;
      }
      added += data.length;
      if (data.length < 1000) break;
      from += 1000;
    }

    if (!added) {
      await supabase.from('campaigns').delete().eq('id', camp.id);
      return bad(res, 'nenhum contato com opt-in encontrado' + (tag ? ` para a etiqueta "${tag}"` : ''));
    }
    res.json({ ok: true, campaign: camp, recipients: added });
  } catch (e) {
    fail(res, e);
  }
});

router.get('/campaigns/:id/recipients', async (req, res) => {
  try {
    let q = supabase
      .from('campaign_recipients')
      .select('id,status,error,sent_at,contact:contacts(name,phone)')
      .eq('campaign_id', req.params.id)
      .order('seq')
      .limit(200);
    if (req.query.status) q = q.eq('status', String(req.query.status));
    const { data, error } = await q;
    if (error) throw error;
    res.json(data);
  } catch (e) {
    fail(res, e);
  }
});

// ---------- anexo da campanha (imagem, video ou documento) ----------

const decodeH = (v) => {
  try {
    return decodeURIComponent(String(v || ''));
  } catch {
    return String(v || '');
  }
};
const rawBody = express.raw({ type: () => true, limit: MAX_BYTES + 1024 });

// Corpo = bytes do arquivo. Cabecalhos: X-File-Type (tipo real) e X-File-Name (encodeURIComponent).
// ATENCAO: estas rotas ficam ANTES de "/campaigns/:id/:action" para nao serem confundidas com ela.
router.post('/campaigns/:id/media', rawBody, async (req, res) => {
  try {
    const { data: c, error } = await supabase
      .from('campaigns')
      .select('id,status,channel_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!c) return res.status(404).json({ error: 'campanha nao encontrada' });
    if (!['draft', 'paused'].includes(c.status)) {
      return bad(res, 'so e possivel trocar o anexo de uma campanha em rascunho ou pausada');
    }

    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || !buffer.length) return bad(res, 'arquivo vazio');
    if (buffer.length > MAX_BYTES) return res.status(413).json({ error: 'arquivo muito grande (maximo 20 MB)' });

    const mime = decodeH(req.get('x-file-type')).split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    const kind = kindFromMime(mime);
    if (kind === 'audio') return bad(res, 'audio nao pode ser anexado a uma campanha. Use imagem, video ou PDF.');

    const name = decodeH(req.get('x-file-name')).trim().slice(0, 120) || defaultName(kind, mime);
    const path = mediaPath(c.channel_id, `campanha-${c.id}`, name);
    await uploadMedia(path, buffer, mime);

    const { error: e2 } = await supabase
      .from('campaigns')
      .update({ media_path: path, media_mime: mime, media_name: name, media_size: buffer.length, note: null })
      .eq('id', c.id);
    if (e2) throw e2;
    res.json({ ok: true, media: { name, mime, size: buffer.length, kind } });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/campaigns/:id/media/remove', async (req, res) => {
  try {
    const { data: c, error } = await supabase.from('campaigns').select('id,status').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!c) return res.status(404).json({ error: 'campanha nao encontrada' });
    if (!['draft', 'paused'].includes(c.status)) return bad(res, 'so e possivel remover o anexo de uma campanha em rascunho ou pausada');
    const { error: e2 } = await supabase
      .from('campaigns')
      .update({ media_path: null, media_mime: null, media_name: null, media_size: null })
      .eq('id', c.id);
    if (e2) throw e2;
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

const TRANSITIONS = {
  start: { from: ['draft', 'paused'], to: 'running' },
  pause: { from: ['running'], to: 'paused' },
  cancel: { from: ['draft', 'running', 'paused'], to: 'canceled' },
};

router.post('/campaigns/:id/:action', async (req, res) => {
  try {
    const t = TRANSITIONS[req.params.action];
    if (!t) return res.status(404).json({ error: 'acao desconhecida' });

    const { data: c, error } = await supabase.from('campaigns').select('id,status').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!c) return res.status(404).json({ error: 'campanha nao encontrada' });
    if (!t.from.includes(c.status)) return bad(res, `nao e possivel esta acao em campanha "${c.status}"`);

    const { error: e2 } = await supabase.from('campaigns').update({ status: t.to, note: null }).eq('id', c.id);
    if (e2) throw e2;
    res.json({ ok: true, status: t.to });
  } catch (e) {
    fail(res, e);
  }
});

export default router;
