const cron = require('node-cron');
const { scrapeAndSave, notifyUsers } = require('./agent');
const { scrapeTransferencias } = require('./scrapers/transferencias');
const db = require('./database');
const logger = require('./logger');

let schedulerTask = null;

async function checkAndNotify() {
  const now         = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const currentHour = now.getHours();
  const currentDay  = now.getDay(); // 0 = domingo

  if (currentHour === 8) {
    // ── Às 8h: scrapa, salva e notifica ──────────────────────────────────────
    let promotions, transferencias;
    try {
      ({ promotions, transferencias } = await scrapeAndSave());
    } catch (err) {
      logger.error(`Scheduler: erro no scraper: ${err.message}`);
      return;
    }

    let users;
    try {
      users = await db.getAllActiveUsers();
    } catch (err) {
      logger.error(`Scheduler: erro ao buscar usuários: ${err.message}`);
      return;
    }

    const targets = users.filter(user =>
      user.frequency === 'daily'
        ? user.send_hour === 8
        : user.frequency === 'weekly' &&
          user.day_of_week === currentDay &&
          user.send_hour === 8
    );

    if (targets.length === 0) {
      logger.info('Scraper rodou às 8h mas nenhum usuário para notificar');
      return;
    }

    logger.info(`Notificando ${targets.length} usuário(s) às 8h`);
    try {
      await notifyUsers(targets, promotions, transferencias);
    } catch (err) {
      logger.error(`Scheduler: erro ao notificar usuários: ${err.message}`);
    }

  } else {
    // ── Outros horários: sem scraper, usa banco ───────────────────────────────
    let users;
    try {
      users = await db.getAllActiveUsers();
    } catch (err) {
      logger.error(`Scheduler: erro ao buscar usuários: ${err.message}`);
      return;
    }

    const targets = users.filter(user =>
      user.frequency === 'daily'
        ? user.send_hour === currentHour
        : user.frequency === 'weekly' &&
          user.day_of_week === currentDay &&
          user.send_hour === currentHour
    );

    if (targets.length === 0) {
      logger.info(`Nenhum usuário para notificar às ${currentHour}h`);
      return;
    }

    // Tenta promoções de hoje; se não houver, usa as mais recentes do banco
    let promotions;
    try {
      const todayPromos = await db.getRecentPromotions(500);
      if (todayPromos.length > 0) {
        promotions = todayPromos;
      } else {
        logger.warn(`Sem promoções de hoje às ${currentHour}h — usando fallback do banco`);
        promotions = await db.getLatestPromotions(500);
      }
    } catch (err) {
      logger.error(`Scheduler: erro ao buscar promoções do banco: ${err.message}`);
      return;
    }

    if (promotions.length === 0) {
      logger.warn('Nenhuma promoção disponível no banco para enviar');
      return;
    }

    let transferencias = [];
    try {
      transferencias = await scrapeTransferencias();
    } catch (err) {
      logger.warn(`Scheduler: erro ao buscar transferências: ${err.message}`);
    }

    logger.info(`Notificando ${targets.length} usuário(s) às ${currentHour}h (banco)`);
    try {
      await notifyUsers(targets, promotions, transferencias);
    } catch (err) {
      logger.error(`Scheduler: erro ao notificar usuários: ${err.message}`);
    }
  }
}


function startScheduler() {
  if (schedulerTask) {
    logger.warn('Scheduler já está rodando');
    return;
  }

  schedulerTask = cron.schedule('0 * * * *', async () => {
    logger.info(`Scheduler disparou (${new Date().toLocaleString('pt-BR')})`);
    await checkAndNotify();
  }, {
    timezone: 'America/Sao_Paulo',
  });

  logger.info('Scheduler ativo: scraper roda 1x/hora, envia para usuários do horário');
}

function stopScheduler() {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
    logger.info('Scheduler parado');
  }
}

function isRunning() {
  return schedulerTask !== null;
}

module.exports = { startScheduler, stopScheduler, isRunning, checkAndNotify };
