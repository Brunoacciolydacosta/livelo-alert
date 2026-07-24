/**
 * whatsapp.js — integração com Evolution API
 *
 * A Evolution API é um servidor self-hosted que expõe uma API REST
 * em cima do WhatsApp Web. Você conecta um número dedicado (chip barato)
 * via QR code uma única vez, e depois envia mensagens via HTTP.
 *
 * Setup rápido com Docker (rode antes de iniciar o projeto):
 *
 *   docker run -d \
 *     --name evolution-api \
 *     -p 8080:8080 \
 *     -e AUTHENTICATION_API_KEY=minha-chave-secreta \
 *     atendai/evolution-api:latest
 *
 * Depois acesse http://localhost:8080 para criar a instância e escanear o QR.
 * Documentação: https://doc.evolution-api.com
 */

const logger = require('./logger');

const EVOLUTION_URL      = process.env.EVOLUTION_URL      || 'http://localhost:8080';
const EVOLUTION_API_KEY  = process.env.EVOLUTION_API_KEY  || 'minha-chave-secreta';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'livelo-bot';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function headers() {
  return {
    'Content-Type': 'application/json',
    'apikey': EVOLUTION_API_KEY,
  };
}

async function apiFetch(path, options = {}) {
  const url = `${EVOLUTION_URL}${path}`;
  const res = await fetch(url, { ...options, headers: headers() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Evolution API ${res.status}: ${body}`);
  }
  return res.json();
}

// ─── STATUS DA INSTÂNCIA ──────────────────────────────────────────────────────

async function getInstanceStatus() {
  try {
    const data = await apiFetch(`/instance/connectionState/${EVOLUTION_INSTANCE}`);
    // estado possível: open | connecting | close
    return data?.instance?.state || 'close';
  } catch {
    return 'close';
  }
}

async function isReady() {
  const state = await getInstanceStatus();
  return state === 'open';
}

// Cria a instância se ainda não existir
async function ensureInstance() {
  try {
    await apiFetch('/instance/create', {
      method: 'POST',
      body: JSON.stringify({
        instanceName: EVOLUTION_INSTANCE,
        qrcode: true,
        integration: 'WHATSAPP-BAILEYS',
      }),
    });
    logger.info(`Instância "${EVOLUTION_INSTANCE}" criada na Evolution API`);
    logger.info('Acesse http://localhost:8080 para escanear o QR code com o número do bot');
  } catch (err) {
    // Instância já existe — normal nas reinicializações
    if (!err.message.includes('already') && !err.message.includes('400')) {
      logger.warn(`ensureInstance: ${err.message}`);
    }
  }
}

// ─── FORMATAÇÃO DA MENSAGEM ───────────────────────────────────────────────────

const DIVIDER = '━━━━━━━━━━━━━━━━━━━━';

function formatDate() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long', day: '2-digit', month: 'long',
    timeZone: 'America/Sao_Paulo',
  });
  // Remove o ano — ex: "quinta-feira, 14 de maio de 2026" → "quinta-feira, 14 de maio"
  return fmt.format(now).replace(/ de \d{4}$/, '');
}

function formatTime() {
  return new Date().toLocaleTimeString('pt-BR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
  });
}

/**
 * Filtra, ordena e formata as promoções para um usuário específico.
 *
 * @param {Array}  promotions      — todos os parceiros retornados pelo scraper
 * @param {Array}  userCategories  — categorias de interesse do usuário (strings)
 * @param {Array}  favoriteStores  — lojas favoritas do usuário (strings)
 * @param {Array}  transferencias  — [{ nome, taxa, minimo }] ou null/[]
 * @returns {string} mensagem pronta para envio no WhatsApp
 */
function formatPromoMessage(promotions, userCategories = [], favoriteStores = [], transferencias = [], maxStores = 10, minPointsThreshold = null) {
  const date = formatDate();
  const time = formatTime();

  // Normaliza para comparação case-insensitive
  const favSet  = new Set(favoriteStores.map(s => s.toLowerCase().trim()));
  const catSet  = new Set(userCategories.map(c => c.toLowerCase().trim()));

  // 1. Filtra: loja favorita OU categoria de interesse
  const filtered = promotions.filter(p => {
    const storeLower = (p.store    || '').toLowerCase().trim();
    const catLower   = (p.category || '').toLowerCase().trim();
    return favSet.has(storeLower) || catSet.has(catLower);
  });

  const header = `🛍️ *Suas promoções Livelo — ${date}*`;

  if (filtered.length === 0) {
    return [
      header,
      '',
      '😕 Não há promoções para suas preferências hoje.',
      'Acesse livelo.com.br para ver todas as ofertas disponíveis.',
    ].join('\n');
  }

  // 2. Separa favoritas das demais e ordena cada grupo por pontos DESC
  const isFav  = p => favSet.has((p.store || '').toLowerCase().trim());
  const byPts  = (a, b) => (b.points_per_real || 0) - (a.points_per_real || 0);

  let favorites = filtered.filter(isFav).sort(byPts);
  if (minPointsThreshold != null) {
    favorites = favorites.filter(p => (p.points_per_real || 0) >= minPointsThreshold);
  }
  const others = filtered.filter(p => !isFav(p)).sort(byPts);

  // 3. Limita a maxStores no total (favoritas têm prioridade)
  const selected = [...favorites, ...others].slice(0, maxStores);

  // 4. Monta as linhas de cada loja
  const storeBlocks = selected.map(p => {
    const star = isFav(p) ? '⭐ ' : '';
    const pts  = p.points_per_real != null ? `${p.points_per_real} pts/R$1` : p.multiplier || '';
    return `🏪 ${star}*${p.store}* — ${pts}`;
  });

  // 5. Junta tudo com separadores
  const body = storeBlocks.join(`\n\n${DIVIDER}\n`);

  // 6. Bloco de transferências (opcional)
  const transferBlock = Array.isArray(transferencias) && transferencias.length > 0
    ? [
        '',
        DIVIDER,
        '✈️ *Transferência de pontos*',
        ...transferencias
          .filter(t => t.taxa)
          .map(t => `${t.nome} — ${t.taxa}`),
      ].join('\n')
    : '';

  return [
    header,
    '',
    DIVIDER,
    body,
    transferBlock,
    '',
    DIVIDER,
    `_Dados atualizados às ${time}. Acesse livelo.com.br para ver todas._`,
  ].join('\n');
}

// ─── ENVIO ────────────────────────────────────────────────────────────────────

async function sendPromoAlert({ phone, promotions, userCategories, favoriteStores, transferencias, maxStores, minPointsThreshold }) {
  // Normaliza: remove não-dígitos, garante código do país
  let normalized = phone.replace(/\D/g, '');
  if (!normalized.startsWith('55')) normalized = '55' + normalized;

  const message = formatPromoMessage(promotions, userCategories, favoriteStores, transferencias, maxStores, minPointsThreshold);

  try {
    await apiFetch(`/message/sendText/${EVOLUTION_INSTANCE}`, {
      method: 'POST',
      body: JSON.stringify({
        number: normalized,
        text: message,
      }),
    });

    logger.info(`Mensagem enviada para ${phone} via Evolution API (${promotions.length} promoções)`);
    return { success: true };
  } catch (err) {
    logger.error(`Erro ao enviar para ${phone}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Garante que a instância existe ao importar o módulo
ensureInstance().catch(() => {});

module.exports = { sendPromoAlert, isReady, formatPromoMessage, getInstanceStatus };
