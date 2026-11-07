# Finly - backend

Recebe mensagens da Evolution API (webhook), salva no Supabase e envia mensagens.

## Variaveis (Railway > servico finly-backend > Variables)

| Variavel | O que e |
|---|---|
| SUPABASE_URL | Project URL do Supabase |
| SUPABASE_SERVICE_ROLE_KEY | Chave service_role (secreta) |
| EVOLUTION_URL | URL publica da Evolution (https://...up.railway.app) |
| EVOLUTION_API_KEY | AUTHENTICATION_API_KEY da Evolution |
| EVOLUTION_INSTANCE | Nome da instancia (teste) |
| WEBHOOK_SECRET | Outra senha longa inventada (protege o webhook) |
| ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME | Cria o primeiro administrador do inbox (apague a senha depois) |
| ADMIN_RESET | `true` junto com ADMIN_PASSWORD redefine a senha do admin no proximo deploy |

## Rotas

- `GET /health` confere se esta no ar (a raiz `/` leva ao /inbox)
- `POST /webhook/evolution?secret=WEBHOOK_SECRET` recebe eventos da Evolution
- `GET /api/conversations`, `GET /api/conversations/:id/messages`
- `POST /api/send` com `{ "number": "62999999999", "text": "Ola" }`
- `POST /api/conversations/:id/reply` com `{ "text": "Ola" }`

As rotas `/api` exigem login (header `Authorization: Bearer <token>`). Nao ha mais chave tecnica.

## Telas

- `/inbox` atendimento com login (conversas, chat, atribuicao, equipe)
- `/campanhas` contatos e disparos (login de administrador; usa a mesma sessao do /inbox)

## Inbox / login

- `POST /auth/login`, `POST /auth/refresh`
- `GET /api/inbox/conversations?filter=all|mine|unassigned|unread|closed&q=`
- `GET /api/inbox/conversations/:id`, `POST .../reply`, `.../assign`, `.../status`, `.../read`
- `GET/POST /api/agents`, `POST /api/agents/:id/update` (somente admin)
- Campanhas e contatos: somente administradores

Rode `finly_migracao_03_inbox.sql` no Supabase antes do deploy.

## Midia

- Recebe imagem, video, audio, documento e figurinha: o webhook baixa o arquivo na Evolution e guarda no
  Supabase Storage (pasta privada `media`). So atendentes logados conseguem abrir (`GET /api/media/:id`).
- Envio pelo painel: botao de clipe, Ctrl+V (imagem) ou arrastar arquivo. Limite de 20 MB.
  `POST /api/inbox/conversations/:id/media` (corpo = bytes; cabecalhos X-File-Type, X-File-Name, X-Caption).
- Rode `finly_migracao_04_midia.sql` no Supabase antes do deploy.

## Campanha com anexo

- Cada campanha pode ter 1 arquivo (imagem, video ou documento, ate 20 MB; audio nao). O texto vira a legenda.
- `POST /api/campaigns/:id/media` (corpo = bytes; cabecalhos X-File-Type, X-File-Name) e
  `POST /api/campaigns/:id/media/remove`. So em campanha em rascunho ou pausada.
- O arquivo e guardado uma vez; cada contato recebe a mesma midia. Rode `finly_migracao_05_campanha_midia.sql`
  (depois da 04) antes do deploy.

## Numeros do WhatsApp (Brasil)

- Telefones sao guardados sempre com o nono digito (`5561992273131`).
- Antes de cada envio de campanha o Finly consulta a Evolution (`/chat/whatsappNumbers`) testando o numero com e
  sem o 9 e envia para o endereco (JID) que realmente existe. Quem nao tem WhatsApp fica como
  "ignorado: sem WhatsApp" (nao conta como falha e nao pausa a campanha).
- Falha da propria consulta (Evolution fora do ar) fica como falha normal.

## Equipes e direcionamento de respostas

- Admin cria equipes (aba Equipes do /inbox), define quem faz parte e se as respostas sao distribuidas
  automaticamente (atendente com menos conversas abertas) ou ficam numa fila da equipe.
- Cada campanha escolhe a equipe que recebe as respostas. Quando o cliente responde (ate 7 dias depois do
  disparo), a conversa vai para a equipe. Se quem ja atende o cliente for da equipe, ele continua com a conversa.
  Cada campanha direciona uma unica vez (troca manual do atendente e respeitada).
- Atendentes podem enviar uma conversa para outra equipe e filtrar a lista por equipe.
- `GET/POST /api/teams`, `POST /api/teams/:id/update|delete|members`, `POST /api/inbox/conversations/:id/team`,
  `POST /api/campaigns/:id/team`. Rode `finly_migracao_06_equipes.sql` antes do deploy.

## Visual

- Estilos em `public/assets/app.css` (compartilhado). A cor identifica a equipe em toda a interface.
