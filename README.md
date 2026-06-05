# 🎯 Livelo Promo Alert

Agente que monitora promoções da Livelo, salva em banco de dados e envia alertas via WhatsApp.

## Estrutura do projeto

```
livelo-alert/
├── README.md
├── package.json
├── .env.example
├── src/
│   ├── index.js          # Servidor Express (UI + API)
│   ├── agent.js          # Orquestrador do agente
│   ├── scraper.js        # Scraper do site Livelo (Playwright)
│   ├── database.js       # SQLite — salva promoções e usuários
│   ├── whatsapp.js       # Envio de mensagens WhatsApp
│   └── scheduler.js      # Agendamento diário (cron)
└── public/
    └── index.html        # Interface do usuário
```

## Instalação

```bash
# 1. Clone / copie o projeto
cd livelo-alert

# 2. Instale as dependências
npm install

# 3. Instale os navegadores do Playwright
npx playwright install chromium

# 4. Configure as variáveis de ambiente
cp .env.example .env
# edite o .env conforme necessário

# 5. Inicie o servidor
npm start
```

## Como usar

1. Acesse `http://localhost:3000`
2. Preencha suas categorias de interesse, lojas favoritas e número WhatsApp
3. Clique em **"Buscar promoções agora"** para rodar o agente imediatamente
4. Ou ative o **agendamento diário** para receber alertas todo dia às 8h

## Notas sobre WhatsApp

Este projeto usa `whatsapp-web.js`, que conecta via QR code no seu WhatsApp pessoal.
Na primeira execução, escaneie o QR code exibido no terminal.

## Variáveis de ambiente

| Variável | Descrição | Padrão |
|---|---|---|
| `PORT` | Porta do servidor | `3000` |
| `CRON_SCHEDULE` | Horário do agendamento | `0 8 * * *` (8h diário) |
| `DB_PATH` | Caminho do banco SQLite | `./data/livelo.db` |
