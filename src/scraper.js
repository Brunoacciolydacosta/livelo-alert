const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const logger = require('./logger');

const LIVELO_URL = 'https://www.livelo.com.br/juntar-pontos/todos-os-parceiros';

const CONTEXT_OPTIONS = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  locale: 'pt-BR',
  timezoneId: 'America/Sao_Paulo',
};

function stripHtml(html) {
  if (!html) return null;
  const text = html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?(p|li|div|h\d)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

async function fetchPartnerDetails(browser, url) {
  const context = await browser.newContext(CONTEXT_OPTIONS);
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const raw = await page.evaluate(() => document.getElementById('__NEXT_DATA__')?.textContent);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const components = data?.props?.pageProps?.page?.components || [];
    const main = components.find(c => c.type === 'cb_partner_main_details_web');
    const pp = main?.props?.partnerProfile;
    if (!pp) return null;
    return {
      description: stripHtml(pp.description),
      coupon: pp.coupon || null,
      credit_term: pp.creditTermText || null,
      journey_type: pp.journeyType || null,
    };
  } catch {
    return null;
  } finally {
    await context.close();
  }
}

async function scrapePromotions() {
  logger.info('Iniciando scraping da Livelo via __NEXT_DATA__...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({ ...CONTEXT_OPTIONS, viewport: { width: 1280, height: 800 } });

  const page = await context.newPage();

  try {
    logger.info(`Acessando ${LIVELO_URL}`);
    await page.goto(LIVELO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const raw = await page.evaluate(() => document.getElementById('__NEXT_DATA__')?.textContent);
    if (!raw) throw new Error('__NEXT_DATA__ não encontrado na página');

    const data = JSON.parse(raw);
    const components = data?.props?.pageProps?.page?.components || [];
    const partnerList = components.find(c => c.type === 'cb_partner_list');
    if (!partnerList) throw new Error('Componente cb_partner_list não encontrado em __NEXT_DATA__');

    // Mapa slug → label a partir de searchPartner.categories
    const categoryOptions = partnerList.props?.searchPartner?.categories || [];
    const slugToLabel = {};
    for (const opt of categoryOptions) {
      if (opt.value && opt.text) slugToLabel[opt.value] = opt.text;
    }

    // Fallback para slugs sem label no __NEXT_DATA__
    const SLUG_FALLBACK = {
      saudeebeleza: 'Saúde e Beleza',
      casa: 'Casa e Decoração',
      viagemeservicos: 'Viagem e Serviços',
      passagensaereas: 'Passagens Aéreas',
      bebidas: 'Bebidas',
      perfumariaecosmetico: 'Perfumaria e Cosméticos',
    };

    const configPartners = partnerList.props?.configPartners || [];
    logger.info(`${configPartners.length} parceiros encontrados em __NEXT_DATA__`);

    const promotions = [];

    for (const partner of configPartners) {
      try {
        const name = partner.name?.trim();
        if (!name) continue;

        // Primeira categoria não-"todos"
        const categorySlugs = (partner.categories || '').split(' ').filter(s => s && s !== 'todos');
        const categorySlug = categorySlugs[0] || '';
        const category = (slugToLabel[categorySlug] || SLUG_FALLBACK[categorySlug] || categorySlug || 'Outros').trim();

        const parity = partner.parity?.parity ?? null;
        const parityClub = partner.parity?.parityClub ?? null;
        const pointsPerReal = parity || null;

        // Multiplier legível
        let multiplier = null;
        if (parity) multiplier = `${parity} ponto${parity !== 1 ? 's' : ''} por R$ 1`;

        const url = partner.link?.startsWith('http')
          ? partner.link.replace('://livelo.com.br', '://www.livelo.com.br')
          : partner.link ? 'https://www.livelo.com.br' + partner.link : null;

        const imageUrl = partner.image || null;

        promotions.push({
          store: name,
          category,
          title: name + (multiplier ? ` — ${multiplier}` : ''),
          description: null,
          coupon: null,
          credit_term: null,
          journey_type: null,
          points_per_real: pointsPerReal,
          multiplier,
          url,
          image_url: imageUrl,
          valid_until: null,
        });
      } catch { /* ignora erros individuais */ }
    }

    // Remove duplicatas por nome
    const seen = new Set();
    const unique = promotions.filter(p => {
      const key = p.store.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Busca detalhes individuais em paralelo (lotes de 10)
    const BATCH_SIZE = 10;
    const totalBatches = Math.ceil(unique.length / BATCH_SIZE);
    logger.info(`Buscando detalhes de ${unique.length} parceiros em lotes de ${BATCH_SIZE}...`);

    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      const batch = unique.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const details = await Promise.all(batch.map(p => fetchPartnerDetails(browser, p.url)));
      let fetched = 0;
      for (let j = 0; j < batch.length; j++) {
        if (details[j]) {
          Object.assign(batch[j], details[j]);
          fetched++;
        }
      }
      logger.info(`Lote ${batchNum}/${totalBatches}: ${fetched}/${batch.length} com detalhes`);
      if (i + BATCH_SIZE < unique.length) await new Promise(r => setTimeout(r, 2000));
    }

    logger.info(`Scraping concluído: ${unique.length} promoções únicas encontradas`);
    return unique;

  } catch (err) {
    logger.error(`Erro no scraping: ${err.message}`);
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { scrapePromotions };
