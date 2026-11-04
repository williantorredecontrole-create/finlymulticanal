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

## Rotas

- `GET /` confere se esta no ar
- `POST /webhook/evolution?secret=WEBHOOK_SECRET` recebe eventos da Evolution
- `GET /teste` painel simples para testar envio e ver conversas
- `GET /api/conversations`, `GET /api/conversations/:id/messages`
- `POST /api/send` com `{ "number": "62999999999", "text": "Ola" }`
- `POST /api/conversations/:id/reply` com `{ "text": "Ola" }`

As rotas `/api` exigem o header `x-api-key` com o valor de FINLY_API_KEY.
