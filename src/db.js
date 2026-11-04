import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Faltam as variaveis SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

// Chave service_role: usada so aqui no backend, nunca no navegador.
// "ws" garante o WebSocket em qualquer versao do Node (o Node 20 nao tem nativo).
export const supabase = createClient(url, key, {
  auth: { persistSession: false },
  realtime: { transport: ws },
});
