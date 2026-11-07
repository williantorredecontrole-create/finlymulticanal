import { supabase } from '../db.js';

// Respostas a uma campanha so sao direcionadas se vierem ate 7 dias depois do disparo.
const WINDOW_DAYS = 7;

// Escolhe, entre os atendentes ativos da equipe, quem tem menos conversas abertas.
export async function pickAgent(teamId) {
  const { data: members } = await supabase.from('team_members').select('agent:agents(id,active)').eq('team_id', teamId);
  const ids = (members || []).map((m) => m.agent).filter((a) => a && a.active).map((a) => a.id);
  if (!ids.length) return null;

  let best = null;
  for (const id of ids) {
    const { count } = await supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('assigned_to', id)
      .eq('status', 'open');
    const n = count || 0;
    if (!best || n < best.n || (n === best.n && Math.random() < 0.5)) best = { id, n };
  }
  return best.id;
}

// Coloca a conversa na equipe. Mantem o atendente atual se ele ja faz parte da equipe;
// senao distribui automaticamente (se a equipe estiver configurada assim) ou deixa na fila da equipe.
export async function routeToTeam(conversation, teamId) {
  const { data: team } = await supabase.from('teams').select('id,auto_distribute').eq('id', teamId).maybeSingle();
  if (!team) return null;

  let assignedTo = null;
  if (conversation.assigned_to) {
    const { data: m } = await supabase
      .from('team_members')
      .select('agent_id')
      .eq('team_id', teamId)
      .eq('agent_id', conversation.assigned_to)
      .maybeSingle();
    if (m) assignedTo = conversation.assigned_to;
  }
  if (!assignedTo && team.auto_distribute) assignedTo = await pickAgent(teamId);

  const { error } = await supabase
    .from('conversations')
    .update({ team_id: teamId, assigned_to: assignedTo })
    .eq('id', conversation.id);
  if (error) throw error;
  return { teamId, assignedTo };
}

// Um de cada vez por conversa (duas mensagens seguidas do cliente nao distribuem duas vezes)
const locks = new Map();

async function routeCampaignReplyNow(conversationId) {
  const { data: conversation } = await supabase
    .from('conversations')
    .select('id,assigned_to,team_id,routed_campaign_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conversation) return null;

  // ultima mensagem de CAMPANHA que enviamos nesta conversa
  const { data: last } = await supabase
    .from('messages')
    .select('campaign_id,created_at')
    .eq('conversation_id', conversationId)
    .eq('direction', 'out')
    .not('campaign_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!last) return null;
  if (conversation.routed_campaign_id === last.campaign_id) return null; // ja direcionada por essa campanha
  if (Date.now() - new Date(last.created_at).getTime() > WINDOW_DAYS * 86400000) return null;

  // marca antes, para nunca direcionar duas vezes
  await supabase.from('conversations').update({ routed_campaign_id: last.campaign_id }).eq('id', conversationId);

  const { data: campaign } = await supabase.from('campaigns').select('team_id').eq('id', last.campaign_id).maybeSingle();
  if (!campaign?.team_id) return null;
  return routeToTeam(conversation, campaign.team_id);
}

// Chamado quando o cliente responde: se a ultima coisa que recebeu foi uma campanha com equipe, direciona.
export function routeCampaignReply(conversationId) {
  const prev = locks.get(conversationId) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => routeCampaignReplyNow(conversationId));
  locks.set(conversationId, run);
  run.finally(() => { if (locks.get(conversationId) === run) locks.delete(conversationId); }).catch(() => {});
  return run;
}
