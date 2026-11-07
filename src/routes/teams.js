import { Router } from 'express';
import { supabase } from '../db.js';
import { requireAdmin } from '../services/auth.js';

// Montado dentro de /api (ja autenticado). Qualquer atendente ve as equipes; so admin altera.
const router = Router();

const fail = (res, e, code) => res.status(code || e.status || 500).json({ error: e.message || String(e) });
const bad = (res, msg) => res.status(400).json({ error: msg });

router.get('/teams', async (req, res) => {
  try {
    const { data: teams, error } = await supabase.from('teams').select('id,name,auto_distribute').order('name');
    if (error) throw error;
    const { data: rows, error: e2 } = await supabase.from('team_members').select('team_id,agent:agents(id,name,active)');
    if (e2) throw e2;

    const byTeam = new Map();
    for (const r of rows || []) {
      if (!r.agent || !r.agent.active) continue;
      if (!byTeam.has(r.team_id)) byTeam.set(r.team_id, []);
      byTeam.get(r.team_id).push({ id: r.agent.id, name: r.agent.name });
    }
    res.json(
      teams.map((t) => {
        const members = (byTeam.get(t.id) || []).sort((a, b) => a.name.localeCompare(b.name));
        return { ...t, members, mine: members.some((m) => m.id === req.agent.id) };
      })
    );
  } catch (e) {
    fail(res, e);
  }
});

router.post('/teams', requireAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim().slice(0, 40);
    if (name.length < 2) return bad(res, 'informe o nome da equipe');
    const autoDistribute = req.body?.auto_distribute === undefined ? true : !!req.body.auto_distribute;
    const { data, error } = await supabase
      .from('teams')
      .insert({ name, auto_distribute: autoDistribute })
      .select('id,name,auto_distribute')
      .single();
    if (error) {
      if (error.code === '23505') return bad(res, 'ja existe uma equipe com este nome');
      throw error;
    }
    res.json({ ok: true, team: data });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/teams/:id/update', requireAdmin, async (req, res) => {
  try {
    const patch = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim().slice(0, 40);
      if (name.length < 2) return bad(res, 'nome muito curto');
      patch.name = name;
    }
    if (req.body?.auto_distribute !== undefined) patch.auto_distribute = !!req.body.auto_distribute;
    if (!Object.keys(patch).length) return bad(res, 'nada para alterar');

    const { data: team } = await supabase.from('teams').select('id').eq('id', req.params.id).maybeSingle();
    if (!team) return res.status(404).json({ error: 'equipe nao encontrada' });
    const { error } = await supabase.from('teams').update(patch).eq('id', team.id);
    if (error) {
      if (error.code === '23505') return bad(res, 'ja existe uma equipe com este nome');
      throw error;
    }
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

// As conversas e campanhas da equipe ficam sem equipe (nada e apagado)
router.post('/teams/:id/delete', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('teams').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

// { agent_id, action: "add" | "remove" }
router.post('/teams/:id/members', requireAdmin, async (req, res) => {
  try {
    const { agent_id: agentId, action } = req.body || {};
    if (!agentId || !['add', 'remove'].includes(action)) return bad(res, 'informe agent_id e action (add ou remove)');

    const { data: team } = await supabase.from('teams').select('id').eq('id', req.params.id).maybeSingle();
    if (!team) return res.status(404).json({ error: 'equipe nao encontrada' });

    if (action === 'add') {
      const { data: agent } = await supabase.from('agents').select('id,active').eq('id', agentId).maybeSingle();
      if (!agent || !agent.active) return bad(res, 'atendente invalido ou inativo');
      const { error } = await supabase
        .from('team_members')
        .upsert({ team_id: team.id, agent_id: agentId }, { onConflict: 'team_id,agent_id', ignoreDuplicates: true });
      if (error) throw error;
    } else {
      const { error } = await supabase.from('team_members').delete().eq('team_id', team.id).eq('agent_id', agentId);
      if (error) throw error;
    }
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

export default router;
