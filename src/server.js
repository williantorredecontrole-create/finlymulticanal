import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webhook from './routes/webhook.js';
import api from './routes/api.js';
import authRoutes from './routes/auth.js';
import { ensureAdmin } from './services/auth.js';
import { getChannelByInstance } from './services/messaging.js';
import { startCampaignWorker } from './services/campaigns.js';

const app = express();
app.set('trust proxy', 1); // Railway: IP real do usuario (limite de tentativas de login)
app.use(express.json({ limit: '10mb' }));

const here = path.dirname(fileURLToPath(import.meta.url));

// Painel simples de teste: /teste
app.use('/teste', express.static(path.join(here, '..', 'public')));
// Contatos e campanhas: /campanhas
app.get('/campanhas', (_req, res) => res.sendFile(path.join(here, '..', 'public', 'campanhas.html')));

app.get('/', (_req, res) => res.json({ ok: true, app: 'finly-backend' }));
app.use('/webhook', webhook);
app.use('/auth', authRoutes);
// Tela de atendimento: /inbox
app.get('/inbox', (_req, res) => res.sendFile(path.join(here, '..', 'public', 'inbox.html')));
app.use('/api', api);

const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', async () => {
  console.log(`Finly rodando na porta ${port}`);
  startCampaignWorker();

  try {
    await ensureAdmin();
  } catch (e) {
    console.error('Nao foi possivel preparar o administrador:', e.message);
  }

  for (const name of ['EVOLUTION_URL', 'EVOLUTION_API_KEY', 'FINLY_API_KEY', 'WEBHOOK_SECRET']) {
    if (!process.env[name]) console.warn(`Atencao: variavel ${name} nao definida.`);
  }

  // Garante que o canal da instancia de teste exista no banco
  if (process.env.EVOLUTION_INSTANCE) {
    try {
      await getChannelByInstance(process.env.EVOLUTION_INSTANCE);
      console.log(`Canal "${process.env.EVOLUTION_INSTANCE}" pronto.`);
    } catch (e) {
      console.error('Nao foi possivel preparar o canal:', e.message);
    }
  }
});
