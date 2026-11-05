-- FINLY - migracao 05 (anexo de midia nas campanhas)
-- Cole no Supabase: SQL Editor > New query > Run
-- Pode rodar mais de uma vez sem problema.
-- (Antes, rode a migracao 04 se ainda nao rodou.)

alter table campaigns add column if not exists media_path text;
alter table campaigns add column if not exists media_mime text;
alter table campaigns add column if not exists media_name text;
alter table campaigns add column if not exists media_size bigint;
