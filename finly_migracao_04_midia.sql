-- FINLY - migracao 04 (midia: imagem, audio, video, documentos)
-- Cole no Supabase: SQL Editor > New query > Run
-- Pode rodar mais de uma vez sem problema.

alter table messages add column if not exists media_path text;   -- caminho do arquivo no Storage
alter table messages add column if not exists media_mime text;
alter table messages add column if not exists media_name text;
alter table messages add column if not exists media_size bigint;

-- Pasta privada onde os arquivos ficam guardados (o servidor tambem cria sozinho se faltar)
insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do nothing;
