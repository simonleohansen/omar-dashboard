// ================================================================
// api/budget-loen.js — Hent budget og løndata fra Supabase
//
// GET /api/budget-loen?from=2026-04-01&to=2026-04-30
// ================================================================

export const config = { api: { bodyParser: false } };

async function fetchAll(table, from, to) {
  const baseUrl = `${process.env.SUPABASE_URL}/rest/v1/${table}`
    + `?select=*&dato=gte.${from}&dato=lte.${to}&order=dato&limit=1000`;
  const headers = {
    'apikey': process.env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
  };
  let allRows = [];
  let offset = 0;
  while (true) {
    const r = await fetch(`${baseUrl}&offset=${offset}`, { headers });
    if (!r.ok) throw new Error(await r.text());
    const rows = await r.json();
    allRows = allRows.concat(rows);
    if (rows.length < 1000) break;
    offset += 1000;
  }
  return allRows;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Mangler from og to (YYYY-MM-DD)' });

  try {
    const [budgetRows, loenRows] = await Promise.all([
      fetchAll('budget', from, to),
      fetchAll('loen', from, to),
    ]);

    // Pivoter: { dato: { restaurant: { budget, loen, timer, medarbejdere } } }
    const data = {};
    for (const r of budgetRows) {
      if (!data[r.dato]) data[r.dato] = {};
      if (!data[r.dato][r.restaurant]) data[r.dato][r.restaurant] = {};
      data[r.dato][r.restaurant].budget = parseFloat(r.budget) || 0;
    }
    for (const r of loenRows) {
      if (!data[r.dato]) data[r.dato] = {};
      if (!data[r.dato][r.restaurant]) data[r.dato][r.restaurant] = {};
      data[r.dato][r.restaurant].loen = parseFloat(r.loen) || 0;
      data[r.dato][r.restaurant].timer = parseFloat(r.timer) || 0;
      data[r.dato][r.restaurant].medarbejdere = r.medarbejdere || 0;
    }

    return res.status(200).json({ data, budgetCount: budgetRows.length, loenCount: loenRows.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
