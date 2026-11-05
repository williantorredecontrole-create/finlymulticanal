-- FINLY - migracao 02 (campanhas)
-- Cole no Supabase: SQL Editor > New query > Run
-- Pode rodar mais de uma vez sem problema.

-- Ordem de envio dos destinatarios
alter table campaign_recipients
  add column if not exists seq bigint generated always as identity;

-- Janela de horario permitido (horas, horario de Brasilia) e observacoes da campanha
alter table campaigns add column if not exists window_start int not null default 8;
alter table campaigns add column if not exists window_end int not null default 20;
alter table campaigns add column if not exists note text;

create index if not exists idx_recipients_pending
  on campaign_recipients (campaign_id, seq) where status = 'pending';

-- Resumo por campanha (usado nos relatorios)
create or replace view campaign_stats as
select
  campaign_id,
  count(*)                                        as total,
  count(*) filter (where status = 'pending')      as pending,
  count(*) filter (where status = 'sent')         as sent,
  count(*) filter (where status = 'delivered')    as delivered,
  count(*) filter (where status = 'read')         as read,
  count(*) filter (where status = 'failed')       as failed,
  count(*) filter (where status = 'skipped')      as skipped
from campaign_recipients
group by campaign_id;

-- A view respeita a seguranca das tabelas e nao fica aberta ao publico
alter view campaign_stats set (security_invoker = true);
revoke all on campaign_stats from anon, authenticated;
