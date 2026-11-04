import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Faltam as variaveis SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

// Chave service_role: usada so aqui no backend, nunca no navegador.
export const supabase = createClient(url, key, { auth: { persistSession: false } });
