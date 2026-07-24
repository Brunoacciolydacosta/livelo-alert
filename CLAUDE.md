# Livelo Alert — Documentação do Projeto

## Objetivo

Agente que monitora diariamente as promoções de parceiros da Livelo
(livelo.com.br/juntar-pontos/todos-os-parceiros), persiste os dados no
Supabase (PostgreSQL) e envia alertas personalizados via WhatsApp usando a
Evolution API. Cada usuário cadastrado recebe uma mensagem com as promoções
filtradas pelas suas categorias e lojas favoritas.

---

## Estrutura de Arquivos

```
PromocoesLivelo/
├── src/
│   ├── index.js        Servidor Express (porta 3000) + inicialização geral
│   ├── scraper.js      Scraping da Livelo via __NEXT_DATA__ (playwright-extra)
│   ├── database.js     Camada de dados — Supabase (PostgreSQL)
│   ├── scheduler.js    Cron job horário usando node-cron
│   ├── whatsapp.js     Integração com Evolution API para envio no WhatsApp
│   ├── agent.js        Orquestra scraper + transferências + DB + whatsapp
│   ├── logger.js       Winston — logs em arquivo (logs/) + console
│   └── scrapers/
│       └── transferencias.js  Taxas de transferência Livelo → Azul/LATAM/Smiles
├── logs/                    Arquivos de log diários (gitignore)
│   ├── combined-YYYY-MM-DD.log   Todos os níveis
│   └── error-YYYY-MM-DD.log      Apenas erros
├── test-scraper.js          Script de teste isolado do scraper
├── test-transferencias.js   Script de teste das taxas de transferência
├── test-whatsapp-message.js Script de prévia da mensagem (usa scraper-resultado.json)
├── package.json
└── .env                     Variáveis de ambiente (não commitado)
```

### src/logger.js

Winston com dois transportes de arquivo (`winston-daily-rotate-file`): `logs/combined-*.log`
(todos os níveis) e `logs/error-*.log` (apenas erros). Rotação diária, retenção 14 dias.
**Todos os módulos `src/` devem usar `logger` em vez de `console.*`.**
Formato: `YYYY-MM-DD HH:mm:ss [LEVEL] mensagem`

### src/scraper.js

**Fase 1 — listagem (~5s):** acessa a URL da Livelo uma única vez, lê o
`<script id="__NEXT_DATA__">` e extrai os 259 parceiros com nome, categoria,
pontos por R$1 e URL.

**Fase 2 — detalhes (~115s):** visita cada página individual em lotes de 10
paralelos com delay de 2s entre lotes. Extrai do `__NEXT_DATA__` de cada
página: `description` (texto limpo, sem HTML), `coupon`, `credit_term`,
`journey_type`. Parceiros bloqueados pelo rate-limit ficam com esses campos
como `null` (não é erro).

Retorna array de objetos:
`{ store, category, title, description, coupon, credit_term, journey_type,
points_per_real, multiplier, url, image_url, valid_until }`

⚠️ `valid_until` é **sempre `null`** — a Livelo não expõe data de validade
no `__NEXT_DATA__`. Não usar para filtros ou exibição.

**Distribuição de pontos (referência):** média 5 pts/R$1, mediana 2 pts/R$1,
65 parceiros acima da média. Usar mediana como threshold padrão de destaque.

### src/database.js

Supabase (`@supabase/supabase-js`). Três tabelas: `users`, `promotions`,
`notification_log`. Todas as funções são **async/await**. Credenciais via
`SUPABASE_URL` e `SUPABASE_KEY` no `.env`. Conexão testada e confirmada
(escrita + leitura OK).

Funções exportadas: `upsertUser`, `getUserByPhone`, `getAllActiveUsers`,
`deleteUser`, `markUserNotified`, `savePromotions`, `getPromotionsForUser`,
`getRecentPromotions`, `getLatestPromotions`, `logNotification`.

`getLatestPromotions(limit)` — busca promoções mais recentes **sem restrição de data**
(encontra o `scraped_at` mais recente e retorna todas daquele batch). Usado como fallback
pelo scheduler quando não há promoções de hoje.

### src/scheduler.js

Cron `0 * * * *` — dispara toda hora (timezone America/Sao_Paulo). Fluxo do `checkAndNotify`:

**Se for 8h:**
1. Chama `scrapeAndSave()` — única execução do scraper no dia
2. Filtra usuários com `send_hour === 8` e envia via `notifyUsers()`

**Se não for 8h:**
1. Filtra usuários com `send_hour == hora atual` — se nenhum, encerra sem fazer nada
2. Busca promoções de hoje via `getRecentPromotions(500)`
   - Fallback: se não há promoções de hoje (antes das 8h), usa `getLatestPromotions(500)`
3. Busca taxas de transferência via `scrapeTransferencias()`
4. Envia via `notifyUsers()`

O scraper roda **1 vez/dia (às 8h)** — outros horários consomem apenas o banco.

Exporta `startScheduler`, `stopScheduler`, `isRunning`, `checkAndNotify`.

### src/scrapers/transferencias.js

Visita as 3 páginas individuais de parceiros de transferência com Playwright (stealth,
headless). A taxa de conversão **não está no `__NEXT_DATA__`** — é injetada no DOM
pelo micro-frontend `partnerTransferDetailsV2` após hidratação do JS. Por isso aguarda
4s após `domcontentloaded` e extrai do `body.innerText` com regex.

Retorna: `[{ nome, taxa, minimo }]`

URLs dos 3 parceiros:
- Azul:  `/livelo-para-parceiros/azul/AZLTransfer`
- LATAM: `/livelo-para-parceiros/latam/MTPTransfer`
- Smiles: `/livelo-para-parceiros/smiles/SMLTransfer`

Taxas atuais (todas 1:1): Azul mín 1.000 pts · LATAM mín 12.000 pts · Smiles mín 10.000 pts

### src/whatsapp.js

Wrapper sobre a Evolution API (servidor Docker self-hosted, **v2.3.7** desde 2026-07-24,
stack via docker-compose — ver "Evolution API — Docker Compose" em Próximos Passos). Formata e envia
mensagens de texto via `POST /message/sendText/:instance`. Cria a instância
automaticamente ao iniciar se ela não existir.

⚠️ **Payload correto (v2.x):** `{ number, text: message }` — formato mudou na migração
p/ v2.3.7 (v1.8.x usava `{ number, textMessage: { text: message } }`, hoje retorna HTTP 400).

**Formato da mensagem:** lojas favoritas com ⭐ primeiro, ordenadas por pts/R$1 DESC,
separadores `━━━`, bloco de transferências no final, rodapé com horário.

`formatPromoMessage(promotions, userCategories, favoriteStores, transferencias, maxStores, minPointsThreshold)` —
`transferencias` (4º), `maxStores` (5º, default 10) e `minPointsThreshold` (6º, default null) são opcionais.
`minPointsThreshold` filtra lojas favoritas por pontuação mínima antes de montar a lista.
`maxStores` limita o total de lojas exibidas (favoritas têm prioridade).
`sendPromoAlert` aceita `maxStores` e `minPointsThreshold` e os repassa para `formatPromoMessage`.

### src/index.js

Express na porta 3000. `startScheduler()` é chamado automaticamente dentro do `app.listen` — não é necessário chamar `/api/scheduler/start` manualmente após deploy. Rotas:
- `GET    /api/status`           — estado do WhatsApp e do scheduler
- `POST   /api/users`            — cadastra/atualiza preferências do usuário
- `GET    /api/users/:phone`     — lê preferências salvas
- `DELETE /api/users/:phone`     — remove usuário
- `POST   /api/run`              — dispara o agente manualmente para um telefone
- `GET    /api/promotions`       — lista promoções de hoje
- `POST   /api/scheduler/start`  — ativa o cron
- `POST   /api/scheduler/stop`   — pausa o cron

---

## Decisões Técnicas Importantes

### Por que `__NEXT_DATA__` em vez de scraping do DOM?

O site da Livelo é um Next.js SSR. O servidor injeta todos os dados da página
(parceiros, categorias, pontuação) dentro de um `<script id="__NEXT_DATA__">`
no HTML inicial — **antes** de qualquer execução de JavaScript. Isso significa
que o JSON completo com todos os 259 parceiros, suas categorias reais e a
paridade de pontos está disponível assim que o `domcontentloaded` dispara.

Abordagem anterior (descartada): navegar para cada URL `?categoria=VALUE` e
esperar o React refiltrar os cards — 30 categorias × ~20s cada = ~55 minutos
por execução.

Abordagem atual: ler `__NEXT_DATA__` uma vez →
`props.pageProps.page.components` → componente `cb_partner_list` →
`props.configPartners[]` (array de 259 parceiros) +
`props.searchPartner.categories[]` (mapa slug→label das categorias).
Tempo total: **~1 segundo**.

### Por que playwright-extra com puppeteer-extra-plugin-stealth?

O site da Livelo detecta e bloqueia Playwright/Chromium puro com
"Access Denied". O plugin stealth mascara as assinaturas do browser
automatizado (navigator.webdriver, plugins, languages, etc.) fazendo o
browser parecer um Chrome real. Atenção: o pacote correto é
`puppeteer-extra-plugin-stealth` — ele funciona tanto com puppeteer-extra
quanto com playwright-extra. O pacote `playwright-extra-plugin-stealth`
(sem "puppeteer") existe mas lança erro.

### URL correta da Livelo

```
https://www.livelo.com.br/juntar-pontos/todos-os-parceiros
```

A URL antiga `/ganhe-pontos/compre-e-pontue` foi descontinuada e retorna 404.

### Por que Supabase em vez de SQLite local?

O banco foi migrado de `sql.js` (SQLite WASM in-memory) para **Supabase**
(PostgreSQL gerenciado). Motivos: persistência real sem `fs.writeFileSync`
manual, acesso remoto, dashboard visual para inspecionar dados, e sem
dependência de arquivo `.db` local.

`sql.js` pode ser removido com `npm uninstall sql.js` — não é mais usado.

Credenciais no `.env`:
```
SUPABASE_URL=https://xvpnloudbhztvohckahb.supabase.co
SUPABASE_KEY=<secret key>
```

---

## Estado Atual

### O que já funciona

- [x] **Evolution API rodando via Docker** — v1.8.7, container `evolution-api`, porta 8080
      (v1.x não precisa de PostgreSQL externo)
- [x] **WhatsApp Business conectado** — número 5511978592072, instância `teste` (nome real no container da VPS)
- [x] **Teste de envio confirmado** — mensagem entregue com sucesso via API
- [x] **Bug payload whatsapp.js corrigido** — `textMessage: { text }` em vez de `text`
- [x] **Formato final da mensagem WhatsApp** — lojas favoritas com ⭐ primeiro,
      ordenadas por pts/R$1 DESC, máx 10 lojas, separadores ━━━, rodapé com horário
- [x] **Bloco de transferências no final da mensagem** — Azul, LATAM e Smiles com taxa
- [x] **`src/scrapers/transferencias.js`** — scraper das taxas via DOM renderizado
- [x] **`agent.js`** roda `scrapePromotions` e `scrapeTransferencias` em paralelo (`Promise.all`)
- [x] **`GET /api/preview`** — rota autenticada que gera prévia da mensagem formatada
- [x] **Botão "👁️ Ver prévia"** no dashboard com modal estilo balão WhatsApp
- [x] **Scraper completo — 259 parceiros, 33 categorias, 100% pontos preenchidos**
- [x] **Descritivos: 74% de cobertura (191/259)** — `description`, `coupon`,
      `credit_term`, `journey_type` via páginas individuais em 26 lotes paralelos
- [x] **Tempo de execução: ~2 minutos** (delay de 2s entre lotes para evitar rate-limit)
- [x] 66 parceiros sem descritivo por bloqueio do site — campos ficam `null`, não é bug
- [x] Categorias mapeadas para os labels oficiais da Livelo; slugs sem label
      normalizados via `SLUG_FALLBACK`; todas as URLs com `www.livelo.com.br`
- [x] **Banco migrado para Supabase** — tabelas `users`, `promotions`,
      `notification_log`; todas as funções async/await; conexão testada (escrita + leitura OK)
- [x] Tabela `users` com campos: `phone`, `categories`, `favorite_stores`,
      `frequency` (daily/weekly), `day_of_week`, `send_hour`, `active`, `created_at`,
      `last_notified_at`, `user_id` (uuid → auth.users),
      `min_points_threshold` (integer, nullable — filtro mín de pts/R$1 para lojas favoritas),
      `max_stores_per_message` (integer, default 10 — limite de lojas por mensagem)
- [x] **`src/agent.js`** — dividido em `scrapeAndSave()` + `notifyUsers()` + `runAgent(phone)`
      - `scrapeAndSave()` — scraper + transferências em paralelo + salva no banco; retorna `{ promotions, transferencias }`
      - `notifyUsers(users, promotions, transferencias)` — envia para lista de usuários com dados já coletados
      - `runAgent(phone)` — disparo manual via `/api/run`; chama `scrapeAndSave()` + `notifyUsers()` para um usuário
- [x] **`src/scheduler.js`** refatorado — scraper roda **1x/dia às 8h**; outros horários usam banco com fallback para promoções do dia anterior
- [x] **`.env`** — criado com `SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_ANON_KEY`, `EVOLUTION_*`
- [x] Servidor Express com todas as rotas de API
- [x] Módulo WhatsApp com formatação de mensagem e integração com Evolution API
- [x] **Autenticação completa com Supabase Auth** — login, cadastro, sessão JWT
- [x] **Frontend multi-página** — `login.html`, `setup.html`, `dashboard.html`, `shared.css`
- [x] **Middleware `requireAuth`** no backend valida JWT em rotas protegidas
- [x] **Botão "Cancelar alertas"** no dashboard com modal de confirmação
- [x] **Botão "📱 Testar envio WhatsApp"** no dashboard — usa promoções já salvas (sem rodar scraper), resposta síncrona
- [x] **`POST /api/test-whatsapp`** — auth; busca promoções do banco, busca taxas, envia via `sendPromoAlert`
- [x] **Seção "Promoções de hoje"** removida do dashboard (card, CSS e JS)
- [x] **`src/logger.js`** — Winston; logs em `logs/combined-*.log` e `logs/error-*.log`,
      rotação diária, 14 dias; todos os módulos `src/` usam `logger` em vez de `console.*`
- [x] **`GET /api/logs?lines=N`** — auth; lê últimas N linhas do combined.log do dia
- [x] **Seção "Logs do sistema"** no dashboard — botão "Ver logs", área monospace,
      erros em vermelho e warnings em amarelo
- [x] **`startScheduler()` automático** — chamado no `app.listen` em `src/index.js`; scheduler ativo desde o boot sem intervenção manual
- [x] **Confirmação de email desativada** — Supabase Auth → Sign In / Providers → Confirm email = OFF; `login.html` redireciona direto para `setup.html` após `signUp` bem-sucedido

### O que falta fazer

- [x] Teste end-to-end completo (agente + scraper + WhatsApp) — confirmado na VPS em 2026-07-15
- [x] Em produção — VPS Hostinger 2.25.180.68
- [x] Testar fluxo completo do frontend (cadastro → setup → dashboard) — confirmado em 2026-07-19
- [ ] (Opcional) `npm uninstall sql.js` — não é mais usado após migração para Supabase

---

## Autenticação (Supabase Auth)

Frontend usa `supabase.createClient` com a **anon key** (`SUPABASE_ANON_KEY`, prefixo
`sb_publishable_`). Nunca expor `SUPABASE_KEY` (service_role, `sb_secret_`) no browser.
A rota `GET /api/config` entrega `supabaseUrl` + `supabaseAnonKey` para as páginas HTML.

Middleware `requireAuth` em `src/index.js` valida o JWT via `supabaseAuth.auth.getUser(token)`.
Rotas protegidas: `POST /api/users`, `GET /api/users/me`, `PATCH /api/users/me`,
`DELETE /api/users/:phone`.

### SQL aplicado no Supabase

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id);
CREATE UNIQUE INDEX IF NOT EXISTS users_user_id_idx ON users(user_id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS min_points_threshold integer DEFAULT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_stores_per_message integer NOT NULL DEFAULT 10;
```

### Estrutura de Arquivos (atualizada)

```
public/
├── shared.css       Estilos base: reset, variáveis CSS, card, botões, toast, animações
├── login.html       Login + cadastro (Supabase Auth JS CDN); redireciona após auth
├── setup.html       Configuração inicial e edição de preferências (?edit=1 para editar)
├── dashboard.html   Painel: status WA, perfil, ações (buscar, prévia, testar envio, cancelar), logs
└── index.html       Redireciona imediatamente para /login.html
```

**Campos do formulário em `setup.html`:**
- Horário de envio: `<select>` com opções 06h–22h (valores inteiros), **NÃO** `input[type="time"]`
- `min_points_threshold`: checkbox + `input[type="number"]` habilitado apenas quando checkbox marcado
- `max_stores_per_message`: `<select>` 1–10 lojas (default 10)

### Funções em src/database.js (acumuladas)

Exportadas: `upsertUser` (aceita `userId`, `minPointsThreshold`, `maxStoresPerMessage`), `getUserByPhone`, `getUserByUserId`,
`setUserActive`, `getAllActiveUsers`, `deleteUser`, `markUserNotified`,
`savePromotions`, `getPromotionsForUser`, `getRecentPromotions`, `getLatestPromotions`,
`logNotification`.

### Rotas em src/index.js (acumuladas)

- `GET  /api/config`        — público; entrega `supabaseUrl` + `supabaseAnonKey`
- `GET  /api/status`        — público
- `GET  /api/logs?lines=N`  — auth; últimas N linhas (máx 500) do combined.log do dia
- `GET  /api/users/me`      — auth; perfil do usuário logado (lookup por `user_id`)
- `POST /api/users`         — auth; cria/atualiza preferências, salva `user_id`
- `PATCH /api/users/me`     — auth; atualiza campo `active` (`{ active: true|false }`)
- `GET  /api/users/:phone`  — público (uso interno/admin)
- `DELETE /api/users/:phone`— auth
- `POST /api/run`           — público; dispara `runAgent(phone)` em background (scrapa + envia)
- `GET  /api/promotions`    — público; promoções do dia
- `POST /api/scheduler/start|stop` — público
- `GET  /api/preview`       — auth; prévia da mensagem (usa banco se tiver promoções hoje, senão roda scraper)
- `POST /api/test-whatsapp` — auth; envia mensagem real usando promoções do banco (sem scraper); erro se banco vazio

---

## Próximos Passos

### Evolution API — Docker Compose (migrado para v2.3.7 em 2026-07-24)

Migrado de container único `atendai/evolution-api:v1.8.7` para stack `docker-compose`
em `/opt/evolution/docker-compose.yml`, imagem `evoapicloud/evolution-api:v2.3.7`.
Motivo: v1.8.x parou de entregar mensagens (WhatsApp migrou p/ endereçamento `@lid`,
Baileys antigo não suporta).

⚠️ **O registro `atendai/evolution-api` não existe mais no Docker Hub** — a imagem
foi renomeada para `evoapicloud/evolution-api`. `docker pull atendai/...` falha com
"pull access denied / repository does not exist".

v2.x **exige PostgreSQL** (`DATABASE_ENABLED=true`), diferente da v1.x. Stack com 3
serviços: `postgres:15`, `redis:alpine`, `evolution-api` — todos `restart:
unless-stopped`, volumes nomeados (`postgres_data`, `redis_data`,
`evolution_instances`). Senha do Postgres gerada com `openssl rand -hex 24` e
hardcoded no `DATABASE_CONNECTION_URI` dentro do próprio `docker-compose.yml`
(sem `.env` separado ainda).

Nome real da instância na VPS é `livelo-bot` (não `teste` — instância antiga não
existe mais, tudo recriado do zero na migração para v2).

```bash
cd /opt/evolution && docker compose up -d                                          # subir stack
docker compose -f /opt/evolution/docker-compose.yml logs evolution-api --tail 30   # logs
docker compose -f /opt/evolution/docker-compose.yml ps                             # status dos 3 containers
docker compose -f /opt/evolution/docker-compose.yml restart                        # reiniciar
curl -s http://localhost:8080                                                      # health check (retorna version 2.3.7)
```

---

## Comandos Úteis

```bash
# Matar processo na porta 3000 (npx disponível no projeto)
npx kill-port 3000

# Testar apenas o scraper (sem servidor, sem WhatsApp, sem banco)
node test-scraper.js

# Testar o scraper e salvar resultado em scraper-resultado.json
node test-scraper.js --salvar

# Iniciar o servidor em modo produção
npm start

# Iniciar com hot-reload (desenvolvimento)
npm run dev

# Cadastrar um usuário via API (após npm start)
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{"phone":"11999999999","categories":["Moda e Beleza"],"favoriteStores":[],"frequency":"daily","sendHour":8}'

# Buscar usuário
curl http://localhost:3000/api/users/11999999999

# Deletar usuário
curl -X DELETE http://localhost:3000/api/users/11999999999

# Disparar o agente manualmente para um número
curl -X POST http://localhost:3000/api/run \
  -H "Content-Type: application/json" \
  -d '{"phone":"11999999999"}'

# Ver promoções coletadas hoje
curl http://localhost:3000/api/promotions

# Testar taxas de transferência isoladamente
node test-transferencias.js

# Testar prévia da mensagem formatada (requer scraper-resultado.json)
node test-whatsapp-message.js

# Gerar scraper-resultado.json (necessário para test-whatsapp-message.js)
node test-scraper.js --salvar

# Testar envio direto via Evolution API (bypass do servidor Node) — payload v2.x
curl -X POST http://localhost:8080/message/sendText/livelo-bot \
  -H "Content-Type: application/json" \
  -H "apikey: minha-chave-secreta" \
  -d '{"number":"5511978592072","text":"Teste ✅"}'
```

---

## Deploy

### GitHub

- Repositório: https://github.com/Brunoacciolydacosta/livelo-alert
- Branch: `main`
- `.gitignore` configurado: `node_modules/`, `.env`, `logs/`, `data/`, `scraper-resultado.json`, `*.db`, `diag-*.js`, `*-debug.png`, `test-*.js`, `.claude/`

### VPS Hostinger (produção atual)

- **IP:** 2.25.180.68
- **SO:** Ubuntu 22.04
- **Custo:** ~R$30/mês
- **App:** `/opt/livelo-alert`
- **Acesso:** `ssh root@2.25.180.68` (chave SSH configurada, sem senha)

**Stack rodando:**
- Node.js 20 + PM2 — servidor Express na porta 3000, processo `livelo-alert`
- Evolution API v1.8.7 — container Docker `evolution-api`, porta 8080
- PM2 salvo em `/root/.pm2/dump.pm2` — reinicia automaticamente após reboot

**Para atualizar o servidor após push:**
```bash
ssh root@2.25.180.68 "cd /opt/livelo-alert && git pull && npm install && pm2 restart livelo-alert"
```

**Comandos úteis na VPS:**
```bash
pm2 status                          # estado do processo
pm2 logs livelo-alert --lines 50    # ver logs em tempo real
docker ps                           # verificar Evolution API
docker logs evolution-api           # logs da Evolution API
curl -s http://localhost:3000/api/status   # checar servidor
```

**⚠️ VPS Hostinger:** pode ser suspensa por falta de pagamento. Se inacessível, verificar painel da Hostinger. Após reativar: `pm2 resurrect` pode ser necessário se o processo não subiu automaticamente.

**Checklist após VPS suspensa e reativada:**
1. `ssh root@2.25.180.68 "pm2 status"` — verificar se `livelo-alert` está online (se não: `pm2 resurrect`)
2. Supabase dashboard → tabela `users` → confirmar `active = true` para o usuário
3. `http://2.25.180.68:8080/manager` — reconectar WhatsApp se necessário (QR code)
4. `curl -s http://localhost:3000/api/status` — verificar scheduler e instância WA

**⚠️ Usuário com `active: false`:** se nenhuma mensagem é enviada mas o sistema parece OK, verificar o campo `active` na tabela `users` no Supabase dashboard e setar `true` manualmente se necessário.

**⚠️ Supabase plano gratuito:** pausa após ~1 semana de inatividade. Se o login retornar
`ERR_NAME_NOT_RESOLVED`, acessar [supabase.com/dashboard](https://supabase.com/dashboard)
e clicar em **"Restore project"** (leva ~2 minutos).

**⚠️ Node.js 20 + Supabase:** o `@supabase/realtime-js` exige o pacote `ws` no Node < 22.
Ambos os `createClient` (em `database.js` e `index.js`) já passam `{ realtime: { transport: ws } }`.

### Pendências de infra

- [x] WhatsApp Business conectado na Evolution API da VPS — instância `livelo-bot`, número 5511978592072
- [x] Teste end-to-end completo na VPS — confirmado em 2026-07-15
- [ ] Testar fluxo completo do frontend (cadastro → setup → dashboard)
- [ ] **Investigar erro 463 no envio (WhatsApp)** — mensagem de teste pós-migração p/ v2.3.7
      recebeu `status: 0` (ERROR) com `messageStubParameters: ["463"]`, código do WhatsApp
      associado a restrição por comportamento tipo spam (possivelmente por testes repetidos
      ao mesmo número nesta sessão). Payload/API corretos — falha é na entrega do WhatsApp.
- [ ] **Reativar o scheduler** (`POST /api/scheduler/stop` chamado em 2026-07-24 para evitar
      envios automáticos até o erro 463 ser investigado) — não reativa sozinho, precisa
      `POST /api/scheduler/start` quando resolvido.
