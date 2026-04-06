// ================================================================
// api/reservationer.js — Hent reservationsdata fra Supabase
//
// GET /api/reservationer?from=YYYY-MM-DD&to=YYYY-MM-DD
// GET /api/reservationer?dates=2026-04-01,2026-04-02
//
// Returnerer: { restauranter: { "OMAR": { "2026-04-02": { gaester, reservationer, ... } } } }
// Samme format som easytable.js så frontend kan bruge det direkte
// ================================================================

export const config = { api: { bodyParser: false } };

async function fetchAll(from, to) {
  const baseUrl = `${process.env.SUPABASE_URL}/rest/v1/reservationer`
    + `?select=dato,restaurant,gaester,reservationer,no_shows,frokost,aften`
    + `&dato=gte.${from}&dato=lte.${to}`
    + `&order=dato`;
  const headers = {
    'apikey': process.env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
  };

  let allRows = [];
  let offset = 0;
  while (true) {
    const r = await fetch(`${baseUrl}&limit=1000&offset=${offset}`, { headers });
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

  let from, to;
  if (req.query.dates) {
    const dates = req.query.dates.split(',').map(d => d.trim()).filter(Boolean).sort();
    from = dates[0];
    to = dates[dates.length - 1];
  } else {
    from = req.query.from;
    to = req.query.to;
  }

  if (!from || !to) return res.status(400).json({ error: 'Mangler from/to eller dates parameter' });

  try {
    const rows = await fetchAll(from, to);

    // Format som easytable.js: { restauranter: { "OMAR": { "2026-04-02": { gaester, reservationer, ... } } } }
    const restauranter = {};
    for (const row of rows) {
      if (!restauranter[row.restaurant]) restauranter[row.restaurant] = {};
      restauranter[row.restaurant][row.dato] = {
        gaester: row.gaester || 0,
        reservationer: row.reservationer || 0,
        no_shows: row.no_shows || 0,
        frokost: row.frokost || 0,
        aften: row.aften || 0,
      };
    }

    return res.status(200).json({ restauranter, count: rows.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
