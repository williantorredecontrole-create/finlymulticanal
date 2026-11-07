-- FINLY - migracao 06 (equipes e direcionamento das respostas das campanhas)
-- Cole no Supabase: SQL Editor > New query > Run
-- Pode rodar mais de uma vez sem problema. (Antes, rode as migracoes 03 e 05.)

-- Equipes (ex.: Adimplencia, Vendas)
create table if not exists teams (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  auto_distribute boolean not null default true,  -- distribui entre os atendentes da equipe
  created_at timestamptz not null default now()
);
alter table teams enable row level security;

-- Quem faz parte de cada equipe
create table if not exists team_members (
  team_id uuid not null references teams(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  primary key (team_id, agent_id)
);
alter table team_members enable row level security;

-- Conversa pertence a uma equipe; "routed_campaign_id" evita direcionar duas vezes a mesma campanha
alter table conversations add column if not exists team_id uuid references teams(id) on delete set null;
alter table conversations add column if not exists routed_campaign_id uuid references campaigns(id) on delete set null;
create index if not exists idx_conversations_team on conversations (team_id);

-- Campanha define para qual equipe vao as respostas
alter table campaigns add column if not exists team_id uuid references teams(id) on delete set null;
