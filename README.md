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
| FINLY_API_KEY | Senha longa inventada por voce (protege a API) |
| WEBHOOK_SECRET | Outra senha longa inventada (protege o webhook) |
| ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME | Cria o primeiro administrador do inbox (apague a senha depois) |
| ADMIN_RESET | `true` junto com ADMIN_PASSWORD redefine a senha do admin no proximo deploy |

## Rotas

- `GET /` confere se esta no ar
- `POST /webhook/evolution?secret=WEBHOOK_SECRET` recebe eventos da Evolution
- `GET /teste` painel simples para testar envio e ver conversas
- `GET /api/conversations`, `GET /api/conversations/:id/messages`
- `POST /api/send` com `{ "number": "62999999999", "text": "Ola" }`
- `POST /api/conversations/:id/reply` com `{ "text": "Ola" }`

As rotas `/api` exigem o header `x-api-key` com o valor de FINLY_API_KEY.

## Telas

- `/inbox` atendimento com login (conversas, chat, atribuicao, equipe)
- `/campanhas` contatos e disparos (usa a FINLY_API_KEY)
- `/teste` painel tecnico de teste

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
