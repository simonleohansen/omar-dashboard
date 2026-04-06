// ================================================================
// api/historical-sales.js — Hent historisk salgsdata fra Supabase
//
// GET /api/historical-sales?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Returnerer: { data: { "2026-03-31": { "OMAR": { omsaetning, pax }, ... } } }
// ================================================================

export const config = { api: { bodyParser: false } };

async function fetchAll(from, to) {
  const baseUrl = `${process.env.SUPABASE_URL}/rest/v1/salg`
    + `?select=dato,restaurant,omsaetning,pax`
    + `&dato=gte.${from}&dato=lte.${to}`
    + `&order=dato`;
  const headers = {
    'apikey': process.env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
  };

  // Paginer i blokke af 1000 (Supabase default max)
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

  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Mangler from og to parametre (YYYY-MM-DD)' });

  try {
    const rows = await fetchAll(from, to);

    // Pivoter til { dato: { restaurant: { omsaetning, pax } } }
    const data = {};
    for (const row of rows) {
      if (!data[row.dato]) data[row.dato] = {};
      data[row.dato][row.restaurant] = {
        omsaetning: parseFloat(row.omsaetning) || 0,
        pax: row.pax || 0
      };
    }

    return res.status(200).json({ data, count: rows.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
