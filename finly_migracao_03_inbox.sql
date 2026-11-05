-- FINLY - migracao 03 (inbox com login e atendentes)
-- Cole no Supabase: SQL Editor > New query > Run
-- Pode rodar mais de uma vez sem problema.

-- Atendentes (o id e o mesmo do usuario em Authentication > Users)
create table if not exists agents (
  id uuid primary key,
  name text not null,
  email text not null,
  role text not null default 'agent' check (role in ('admin','agent')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table agents enable row level security;

-- Conversa atribuida a um atendente
alter table conversations drop constraint if exists conversations_assigned_to_fkey;
alter table conversations
  add constraint conversations_assigned_to_fkey
  foreign key (assigned_to) references agents(id) on delete set null;
create index if not exists idx_conversations_assigned on conversations (assigned_to);
create index if not exists idx_conversations_status on conversations (status, last_message_at desc);

-- Quem enviou cada mensagem (atendente)
alter table messages add column if not exists sent_by uuid;
alter table messages drop constraint if exists messages_sent_by_fkey;
alter table messages
  add constraint messages_sent_by_fkey
  foreign key (sent_by) references agents(id) on delete set null;
