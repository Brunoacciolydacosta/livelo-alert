const { scrapePromotions } = require('./scraper');
const { scrapeTransferencias } = require('./scrapers/transferencias');
const db = require('./database');
const { sendPromoAlert } = require('./whatsapp');
const logger = require('./logger');

/**
 * Roda o scraper e salva no banco.
 * Retorna { promotions, transferencias } para reutilização imediata.
 */
async function scrapeAndSave() {
  const [promotions, transferencias] = await Promise.all([
    scrapePromotions(),
    scrapeTransferencias(),
  ]);
  logger.info(`${promotions.length} promoções coletadas`);
  logger.info(`${transferencias.filter(t => t.taxa).length}/3 taxas de transferência coletadas`);

  const inserted = await db.savePromotions(promotions);
  logger.info(`${inserted} novas promoções salvas no banco`);

  return { promotions, transferencias };
}

/**
 * Envia alertas para uma lista de usuários usando promoções já coletadas.
 */
async function notifyUsers(users, promotions, transferencias) {
  for (const user of users) {
    const userPromos = await db.getPromotionsForUser(user);
    logger.info(`Enviando ${userPromos.length} promoções para ${user.phone}`);

    const result = await sendPromoAlert({
      phone:              user.phone,
      promotions:         userPromos,
      userCategories:     user.categories,
      favoriteStores:     user.favorite_stores,
      transferencias,
      maxStores:          user.max_stores_per_message ?? 10,
      minPointsThreshold: user.min_points_threshold   ?? null,
    });

    await db.logNotification({
      phone:          user.phone,
      promotionsSent: userPromos.length,
      success:        result.success,
      errorMessage:   result.error || null,
    });

    if (result.success) await db.markUserNotified(user.phone);
  }
}

/**
 * Disparo manual: scrapa, salva e envia para o usuário indicado.
 * Usado pela rota POST /api/run.
 */
async function runAgent(phone) {
  logger.info(`Agente iniciado para ${phone}`);

  const { promotions, transferencias } = await scrapeAndSave();

  const user = await db.getUserByPhone(phone);
  if (!user) {
    logger.warn(`runAgent: usuário não encontrado para ${phone}`);
    return;
  }

  await notifyUsers([user], promotions, transferencias);
  logger.info('Agente finalizado');
}

module.exports = { runAgent, scrapeAndSave, notifyUsers };
