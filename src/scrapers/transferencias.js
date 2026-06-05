/**
 * scrapers/transferencias.js
 *
 * Extrai as taxas de transferência Livelo → programas de milhagem brasileiros.
 *
 * A taxa de conversão não está no __NEXT_DATA__ estático — ela é injetada no
 * DOM pelo micro-frontend partnerTransferDetailsV2 após hidratação do JS.
 * Por isso aguardamos 4 s após domcontentloaded antes de ler o body.innerText.
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const CONTEXT_OPTIONS = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  locale: 'pt-BR',
  timezoneId: 'America/Sao_Paulo',
};

const PARCEIROS = [
  {
    nome: 'Azul Fidelidade',
    url: 'https://www.livelo.com.br/livelo-para-parceiros/azul/AZLTransfer',
  },
  {
    nome: 'LATAM Pass',
    url: 'https://www.livelo.com.br/livelo-para-parceiros/latam/MTPTransfer',
  },
  {
    nome: 'Smiles',
    url: 'https://www.livelo.com.br/livelo-para-parceiros/smiles/SMLTransfer',
  },
];

/**
 * Extrai a taxa de conversão e o mínimo de uma única página de parceiro.
 * Retorna { nome, taxa, minimo } ou null se não encontrar a taxa.
 */
async function fetchParceiro(browser, parceiro) {
  const page = await browser.newPage();
  try {
    await page.goto(parceiro.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Aguarda hidratação do micro-frontend
    await page.waitForTimeout(4000);

    const text = await page.evaluate(() => document.body.innerText);

    // Padrão: "1 ponto Livelo = 1 milha Azul Fidelidade"
    //         "1 ponto Livelo = 1 milha LATAM Pass"
    const ratioMatch = text.match(
      /(\d[\d.,]*)\s+pont[oe]s?\s+Livelo\s*=\s*(\d[\d.,]*)\s+(?:milha|pont)[oe]?s?/i
    );

    // Padrão: "Transferência mínima: 1.000 pontos"
    const minMatch = text.match(
      /Transfer[eê]ncia\s+m[íi]nima:\s*([\d.,]+)\s*pont/i
    );

    if (!ratioMatch) {
      console.warn(`⚠️  Taxa não encontrada para ${parceiro.nome}`);
      return { nome: parceiro.nome, taxa: null, minimo: minMatch?.[1] ?? null };
    }

    const origem  = ratioMatch[1];  // pontos Livelo
    const destino = ratioMatch[2];  // milhas/pontos no parceiro
    const taxa    = origem === destino ? '1:1' : `${origem}:${destino}`;

    return {
      nome:   parceiro.nome,
      taxa,
      minimo: minMatch?.[1] ?? null,
    };
  } finally {
    await page.close();
  }
}

/**
 * Raspa os 3 parceiros em série (mesmo browser, páginas independentes).
 * Retorna array de { nome, taxa, minimo }.
 */
async function scrapeTransferencias() {
  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext(CONTEXT_OPTIONS);

  const results = [];
  for (const parceiro of PARCEIROS) {
    try {
      const data = await fetchParceiro(ctx, parceiro);
      results.push(data);
      console.log(`✅ ${data.nome}: taxa=${data.taxa} mínimo=${data.minimo} pts`);
    } catch (err) {
      console.warn(`❌ Erro ao buscar ${parceiro.nome}:`, err.message);
      results.push({ nome: parceiro.nome, taxa: null, minimo: null });
    }
  }

  await browser.close();
  return results;
}

module.exports = { scrapeTransferencias };
