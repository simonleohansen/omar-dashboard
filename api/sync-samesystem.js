// ================================================================
// api/sync-samesystem.js — Daglig sync af budget og løn fra SameSystem
//
// Kører via GitHub Actions eller manuelt:
// GET /api/sync-samesystem?run=now
// GET /api/sync-samesystem?run=now&month=2026-04
// ================================================================

export const config = { api: { bodyParser: false } };

const SS_API = 'https://in.samesystem.com/api/v1';
const RESTAURANTS = [
  { name: 'OMAR',   ctx: 'c3266d27205' },
  { name: 'Safari', ctx: 'c3266d27207' },
  { name: 'Lamar',  ctx: 'c3266d27208' },
  { name: 'Kima',   ctx: 'c3266d27206' },
];

async function ssLogin() {
  const r = await fetch(`${SS_API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: (process.env.SAMESYSTEM_EMAIL || '').trim(),
      password: (process.env.SAMESYSTEM_PASSWORD || '').trim(),
    }),
  });
  const data = await r.json();
  if (data.status !== 'ok') throw new Error('SameSystem login fejl: ' + JSON.stringify(data) + ' email=' + (process.env.SAMESYSTEM_EMAIL || 'MISSING') + ' pw_len=' + (process.env.SAMESYSTEM_PASSWORD || '').length);
  return data.token;
}

async function ssGet(token, path) {
  const r = await fetch(`${SS_API}${path}`, {
    headers: { 'AUTHORIZATION': `Token token="${token}"`, 'Content-Type': 'application/json' },
  });
  return r.json();
}

async function upsert(table, rows) {
  if (!rows.length) return;
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?on_conflict=dato,restaurant`, {
    method: 'POST',
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Supabase ${table}: ${r.status} ${await r.text()}`);
}

export default async function handler(req, res) {
  const erCron = req.headers['x-vercel-cron'] === '1';
  const erManuel = req.method === 'GET' && req.query.run === 'now';
  if (!erCron && !erManuel) return res.status(401).json({ error: 'Unauthorized' });

  // Bestem måned: default = indeværende + forrige (for at fange sene ændringer)
  const now = new Date();
  const targetMonths = [];
  if (req.query.month) {
    const [y, m] = req.query.month.split('-').map(Number);
    targetMonths.push({ year: y, month: m });
  } else {
    targetMonths.push({ year: now.getFullYear(), month: now.getMonth() + 1 });
    // Forrige måned også
    const prev = new Date(now); prev.setMonth(prev.getMonth() - 1);
    targetMonths.push({ year: prev.getFullYear(), month: prev.getMonth() + 1 });
  }

  try {
    const token = await ssLogin();
    const allBudget = [];
    const allLoen = [];

    for (const rest of RESTAURANTS) {
      for (const { year, month } of targetMonths) {
        // Budget
        try {
          const bData = await ssGet(token, `/${rest.ctx}/budget/daily/${year}/${month}`);
          for (const b of (bData.daily_budgets || [])) {
            allBudget.push({ dato: b.date, restaurant: rest.name, budget: Math.round((b.amount || 0) * 100) / 100 });
          }
        } catch {}

        // Løn via export/calendar (inkl. tillæg og bonusser)
        try {
          const lastDay = new Date(year, month, 0).getDate();
          const from = `${year}-${String(month).padStart(2, '0')}-01`;
          const to = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
          const calData = await ssGet(token, `/${rest.ctx}/export/calendar?start_date=${from}&end_date=${to}&salary=true&bonuses=true`);
          const entries = Array.isArray(calData) ? calData : [];

          const daglig = {};
          for (const e of entries) {
            // Filtrér til denne restaurant via department.nr
            const deptNr = e.department?.nr || '';
            if (deptNr.toLowerCase() !== rest.name.toLowerCase()) continue;
            const dato = e.date;
            if (!dato || dato < from || dato > to) continue;
            const cost = parseFloat(e.cost) || 0;
            if (cost <= 0) continue;
            // Beregn timer fra work events
            let hours = 0;
            for (const w of (e.events?.work || [])) {
              const h = w.total_hours?.without_breaks || '0:00';
              const [hh, mm] = h.split(':').map(Number);
              hours += (hh || 0) + (mm || 0) / 60;
            }
            if (!daglig[dato]) daglig[dato] = { loen: 0, timer: 0, ids: new Set() };
            daglig[dato].loen += cost;
            daglig[dato].timer += hours;
            daglig[dato].ids.add(e.user?.id || e.user?.name);
          }
          for (const [dato, d] of Object.entries(daglig)) {
            allLoen.push({
              dato, restaurant: rest.name,
              loen: Math.round(d.loen * 100) / 100,
              timer: Math.round(d.timer * 10) / 10,
              medarbejdere: d.ids.size,
            });
          }
        } catch {}
      }
    }

    if (allBudget.length) await upsert('budget', allBudget);
    if (allLoen.length) await upsert('loen', allLoen);

    return res.status(200).json({
      success: true,
      months: targetMonths,
      budget: allBudget.length,
      loen: allLoen.length,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
