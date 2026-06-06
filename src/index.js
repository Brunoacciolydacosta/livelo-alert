require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const logger = require('./logger');
const db = require('./database');
const { runAgent } = require('./agent');
const { startScheduler, stopScheduler, isRunning } = require('./scheduler');
const { isReady: isWhatsAppReady, formatPromoMessage, sendPromoAlert } = require('./whatsapp');
const { scrapePromotions } = require('./scraper');
const { scrapeTransferencias } = require('./scrapers/transferencias');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase client para validação de JWT (usa SUPABASE_KEY no servidor)
const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  { realtime: { transport: ws } }
);

app.use(express.json());

// ─── AUTH MIDDLEWARE ───────────────────────────────────────────────────────────

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token não informado' });

  try {
    const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Token inválido ou expirado' });
    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Erro ao verificar autenticação' });
  }
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────

// Configuração pública para o frontend (anon key do Supabase)
// IMPORTANTE: SUPABASE_ANON_KEY deve ser a chave "anon/public" do Supabase
// (não a service_role). Adicione ao .env se ainda não existir.
app.get('/api/config', (req, res) => {
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!anonKey) {
    return res.status(500).json({
      error: 'SUPABASE_ANON_KEY não configurada. Adicione ao .env a chave anon/public do Supabase.'
    });
  }
  res.json({
    supabaseUrl:     process.env.SUPABASE_URL,
    supabaseAnonKey: anonKey,
  });
});

// Status geral
app.get('/api/status', (req, res) => {
  res.json({
    whatsapp:  isWhatsAppReady() ? 'connected' : 'connecting',
    scheduler: isRunning() ? 'active' : 'inactive',
    schedule:  process.env.CRON_SCHEDULE || '0 8 * * *',
  });
});

// Perfil do usuário autenticado
app.get('/api/users/me', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserByUserId(req.user.id);
    if (!user) return res.status(404).json({ error: 'Perfil não encontrado. Configure suas preferências.' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Salvar / atualizar preferências do usuário (requer autenticação)
app.post('/api/users', requireAuth, async (req, res) => {
  const { phone, categories, favoriteStores, frequency, dayOfWeek, sendHour, minPointsThreshold, maxStoresPerMessage } = req.body;

  if (!phone) return res.status(400).json({ error: 'Número de telefone obrigatório' });

  if (frequency && !['daily', 'weekly'].includes(frequency)) {
    return res.status(400).json({ error: 'frequency deve ser "daily" ou "weekly"' });
  }
  if (sendHour !== undefined && (sendHour < 0 || sendHour > 23)) {
    return res.status(400).json({ error: 'send_hour deve ser entre 0 e 23' });
  }

  try {
    const user = await db.upsertUser({
      phone, categories, favoriteStores, frequency, dayOfWeek, sendHour,
      minPointsThreshold, maxStoresPerMessage,
      userId: req.user.id,
    });
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualizar campo active do usuário logado
app.patch('/api/users/me', requireAuth, async (req, res) => {
  const { active } = req.body;
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: '"active" deve ser true ou false' });
  }
  try {
    await db.setUserActive(req.user.id, active);
    res.json({ success: true, active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Buscar preferências salvas por telefone (uso interno / admin)
app.get('/api/users/:phone', async (req, res) => {
  try {
    const user = await db.getUserByPhone(req.params.phone);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Deletar usuário (requer autenticação)
app.delete('/api/users/:phone', requireAuth, async (req, res) => {
  try {
    await db.deleteUser(req.params.phone);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rodar o agente manualmente para um usuário específico
app.post('/api/run', async (req, res) => {
  const { phone } = req.body;

  if (!phone) return res.status(400).json({ error: 'Número de telefone obrigatório' });

  // Responde imediatamente para o frontend
  res.json({ success: true, message: 'Agente iniciado! Você receberá a mensagem em breve.' });

  // Roda em background
  runAgent(phone).catch(err => {
    logger.error(`Erro no agente: ${err.message}`);
  });
});

// Prévia da mensagem WhatsApp para o usuário logado
app.get('/api/preview', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserByUserId(req.user.id);
    if (!user) return res.status(404).json({ error: 'Perfil não encontrado. Configure suas preferências.' });

    // Usa promoções já salvas hoje; senão roda o scraper
    let promotions = await db.getRecentPromotions(300);
    if (promotions.length === 0) {
      promotions = await scrapePromotions();
    }

    const transferencias = await scrapeTransferencias();

    const message = formatPromoMessage(
      promotions,
      user.categories      || [],
      user.favorite_stores || [],
      transferencias,
      user.max_stores_per_message ?? 10,
      user.min_points_threshold   ?? null,
    );

    res.json({ message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Teste de envio WhatsApp para o usuário logado
app.post('/api/test-whatsapp', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserByUserId(req.user.id);
    if (!user) return res.status(404).json({ error: 'Perfil não encontrado. Configure suas preferências.' });

    const promotions = await db.getRecentPromotions(300);
    if (promotions.length === 0) {
      return res.status(400).json({
        error: 'Nenhuma promoção salva hoje. Clique em "Buscar promoções agora" primeiro.'
      });
    }

    const transferencias = await scrapeTransferencias();

    await sendPromoAlert({
      phone:              user.phone,
      promotions,
      userCategories:     user.categories      || [],
      favoriteStores:     user.favorite_stores || [],
      transferencias,
      maxStores:          user.max_stores_per_message ?? 10,
      minPointsThreshold: user.min_points_threshold   ?? null,
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listar promoções salvas hoje
app.get('/api/promotions', async (req, res) => {
  try {
    const promos = await db.getRecentPromotions(100);
    res.json(promos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Últimas N linhas do combined.log
app.get('/api/logs', requireAuth, (req, res) => {
  const lines = Math.min(parseInt(req.query.lines) || 100, 500);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const logFile = path.join(__dirname, '../logs', `combined-${today}.log`);

  if (!fs.existsSync(logFile)) {
    return res.json({ logs: [] });
  }

  try {
    const content = fs.readFileSync(logFile, 'utf8');
    const all = content.split('\n').filter(l => l.trim());
    const tail = all.slice(-lines);
    res.json({ logs: tail });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Controle do scheduler
app.post('/api/scheduler/start', (req, res) => {
  startScheduler();
  res.json({ success: true, running: isRunning() });
});

app.post('/api/scheduler/stop', (req, res) => {
  stopScheduler();
  res.json({ success: true, running: isRunning() });
});

// Arquivos estáticos (public/) — após as rotas de API
app.use(express.static(path.join(__dirname, '../public')));

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  logger.info(`Livelo Alert rodando em http://localhost:${PORT}`);
  logger.info('Aguardando WhatsApp conectar...');
});
