// ================================================================
// api/economic.js — Hent budget og bogførte tal fra e-conomic
//
// GET /api/economic
// GET /api/economic?from=2025-01-01&to=2025-12-31
//
// Returnerer omsætning og budget pr. restaurant pr. måned.
// Bruger Budgets API og Booked Entries API.
// ================================================================

export const config = { api: { bodyParser: false } };

const RESTAURANTS = [
  { name: 'OMAR',   appSecret: 'ECONOMIC_OMAR_APP_SECRET',   grant: 'ECONOMIC_OMAR_GRANT' },
  { name: 'Safari', appSecret: 'ECONOMIC_SAFARI_APP_SECRET', grant: 'ECONOMIC_SAFARI_GRANT' },
  { name: 'Lamar',  appSecret: 'ECONOMIC_LAMAR_APP_SECRET',  grant: 'ECONOMIC_LAMAR_GRANT' },
  { name: 'Kima',   appSecret: 'ECONOMIC_KIMA_APP_SECRET',   grant: 'ECONOMIC_KIMA_GRANT' },
];

const BUDGET_API = 'https://apis.e-conomic.com/budgetsapi/v2.0.0';
const ENTRIES_API = 'https://apis.e-conomic.com/bookedEntriesapi/v4.0.0';

// Omsætningskonti: 1010-1099 (standard dansk kontoplan)
const ACCOUNT_FILTER = 'accountNumber$gte:1010$and:accountNumber$lte:1099';

function headers(rest) {
  return {
    'X-AppSecretToken': process.env[rest.appSecret],
    'X-AgreementGrantToken': process.env[rest.grant],
    'Content-Type': 'application/json',
  };
}

// Hent alle sider (cursor-based pagination)
async function fetchAll(baseUrl, filter, hdrs) {
  let all = [];
  let url = `${baseUrl}?filter=${filter}&pageSize=1000`;
  while (url) {
    const r = await fetch(url, { headers: hdrs });
    if (!r.ok) {
      const err = await r.text();
      throw new Error(`${r.status}: ${err}`);
    }
    const data = await r.json();
    const items = data.collection || data.items || data;
    if (Array.isArray(items)) all = all.concat(items);
    url = data.pagination?.nextPage || data.cursor?.nextPage || null;
  }
  return all;
}

// Generer månedsliste mellem from og to
function monthRange(from, to) {
  const months = [];
  const cur = new Date(from + 'T12:00:00');
  const end = new Date(to + 'T12:00:00');
  while (cur <= end) {
    const y = cur.getFullYear();
    const m = cur.getMonth();
    const start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const lastDay = new Date(y, m + 1, 0).getDate();
    const slut = `${y}-${String(m + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    months.push({ start, slut, label: `${y}-${String(m + 1).padStart(2, '0')}` });
    cur.setMonth(cur.getMonth() + 1);
  }
  return months;
}

async function hentRestaurant(rest, from, to) {
  const hdrs = headers(rest);
  const result = {};

  // Hent bogførte poster (omsætning)
  const entriesFilter = `${ACCOUNT_FILTER}$and:date$gte:${from}$and:date$lte:${to}`;
  let entries;
  try {
    entries = await fetchAll(`${ENTRIES_API}/booked-entries`, entriesFilter, hdrs);
  } catch (e) {
    entries = [];
    result._entriesError = e.message;
  }

  // Hent budget
  const budgetFilter = `${ACCOUNT_FILTER}$and:fromDate$gte:${from}$and:toDate$lte:${to}`;
  let budgets;
  try {
    budgets = await fetchAll(`${BUDGET_API}/budget-figures`, budgetFilter, hdrs);
  } catch (e) {
    budgets = [];
    result._budgetError = e.message;
  }

  // Aggreger pr. måned
  const months = monthRange(from, to);
  for (const m of months) {
    // Bogført omsætning: sum af amountInBaseCurrency (negeret, da kreditkonti)
    const mEntries = entries.filter(e => e.date >= m.start && e.date <= m.slut);
    const booked = mEntries.reduce((s, e) => s + (e.amountInBaseCurrency || e.amount || 0), 0);

    // Budget: sum af amountDefaultCurrency
    const mBudgets = budgets.filter(b => {
      const bFrom = (b.fromDate || '').slice(0, 10);
      const bTo = (b.toDate || '').slice(0, 10);
      return bFrom >= m.start && bTo <= m.slut;
    });
    const budget = mBudgets.reduce((s, b) => s + (b.amountDefaultCurrency || 0), 0);

    result[m.label] = {
      bogfort: Math.round(Math.abs(booked) * 100) / 100,
      budget: Math.round(Math.abs(budget) * 100) / 100,
    };
  }

  return result;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Standard: indeværende år
  const now = new Date();
  const defaultFrom = `${now.getFullYear()}-01-01`;
  const defaultTo = `${now.getFullYear()}-12-31`;
  const from = req.query.from || defaultFrom;
  const to = req.query.to || defaultTo;

  try {
    const results = {};
    await Promise.all(RESTAURANTS.map(async rest => {
      results[rest.name] = await hentRestaurant(rest, from, to);
    }));

    return res.status(200).json({ from, to, restauranter: results });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
