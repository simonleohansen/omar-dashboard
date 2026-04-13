// ================================================================
// backfill-samesystem.js — Hent al budget- og løndata fra SameSystem
//
// Kør: node backfill-samesystem.js
// ================================================================

const SUPABASE_URL = 'https://uhdvgerbiviephxmvqyq.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoZHZnZXJiaXZpZXBoeG12cXlxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDk5NTA4MiwiZXhwIjoyMDkwNTcxMDgyfQ.pxes28W-POgitAeL3ERujWoX94rktm0liigDEV8bMsY';

const SS_API = 'https://in.samesystem.com/api/v1';
const SS_EMAIL = '2-30.15-15.26@cmesystem.dk';
const SS_PASS = 'M}A%sPpan>]=TDj*X4eA';

const RESTAURANTS = [
  { name: 'OMAR',   ctx: 'c3266d27205' },
  { name: 'Safari', ctx: 'c3266d27207' },
  { name: 'Lamar',  ctx: 'c3266d27208' },
  { name: 'Kima',   ctx: 'c3266d27206' },
];

let token = null;

async function login() {
  const r = await fetch(`${SS_API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: SS_EMAIL, password: SS_PASS }),
  });
  const data = await r.json();
  if (data.status !== 'ok') throw new Error('SameSystem login fejl: ' + JSON.stringify(data));
  token = data.token;
  console.log('Logget ind i SameSystem');
}

async function ssGet(path) {
  const r = await fetch(`${SS_API}${path}`, {
    headers: { 'AUTHORIZATION': `Token token="${token}"`, 'Content-Type': 'application/json' },
  });
  if (r.status === 401) {
    // Token udløbet — log ind igen
    await login();
    return ssGet(path);
  }
  return r.json();
}

async function upsertBatch(table, rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=dato,restaurant`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify(batch),
    });
    if (!r.ok) {
      const err = await r.text();
      throw new Error(`Supabase ${table} upsert fejl: ${r.status} ${err}`);
    }
  }
}

async function main() {
  await login();

  // Find start-år: prøv fra 2023 og fremad
  const startYear = 2023;
  const now = new Date();
  const endYear = now.getFullYear();
  const endMonth = now.getMonth() + 1;

  const allBudget = [];
  const allLoen = [];

  for (const rest of RESTAURANTS) {
    console.log(`\n🔄 ${rest.name}:`);

    // ── BUDGET ──
    let budgetCount = 0;
    for (let year = startYear; year <= endYear; year++) {
      const maxMonth = year === endYear ? endMonth : 12;
      for (let month = 1; month <= maxMonth; month++) {
        try {
          const data = await ssGet(`/${rest.ctx}/budget/daily/${year}/${month}`);
          const budgets = data.daily_budgets || [];
          for (const b of budgets) {
            if (b.amount > 0) {
              allBudget.push({ dato: b.date, restaurant: rest.name, budget: Math.round(b.amount * 100) / 100 });
              budgetCount++;
            }
          }
        } catch (e) {
          // Måned uden data — spring over
        }
        await new Promise(r => setTimeout(r, 100)); // Rate limiting
      }
    }
    console.log(`  Budget: ${budgetCount} dage`);

    // ── LØN ──
    // Hent i 3-måneders intervaller for at undgå for store svar
    let loenCount = 0;
    for (let year = startYear; year <= endYear; year++) {
      const maxMonth = year === endYear ? endMonth : 12;
      for (let qStart = 1; qStart <= maxMonth; qStart += 3) {
        const qEnd = Math.min(qStart + 2, maxMonth);
        const from = `${year}-${String(qStart).padStart(2, '0')}-01`;
        const lastDay = new Date(year, qEnd, 0).getDate();
        const to = `${year}-${String(qEnd).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

        try {
          const calData = await ssGet(`/${rest.ctx}/export/calendar?start_date=${from}&end_date=${to}&salary=true&bonuses=true`);
          const entries = Array.isArray(calData) ? calData : [];

          const daglig = {};
          for (const e of entries) {
            const deptNr = e.department?.nr || '';
            if (deptNr.toLowerCase() !== rest.name.toLowerCase()) continue;
            const dato = e.date;
            if (!dato || dato < from || dato > to) continue;
            const cost = parseFloat(e.cost) || 0;
            if (cost <= 0) continue;
            let hours = 0;
            for (const w of (e.events?.work || [])) {
              const h = w.total_hours?.without_breaks || '0:00';
              const [hh, mm] = h.split(':').map(Number);
              hours += (hh || 0) + (mm || 0) / 60;
            }
            if (!daglig[dato]) daglig[dato] = { loen: 0, timer: 0, medarbejdere: new Set() };
            daglig[dato].loen += cost;
            daglig[dato].timer += hours;
            daglig[dato].medarbejdere.add(e.user?.id || e.user?.name);
          }

          for (const [dato, d] of Object.entries(daglig)) {
            allLoen.push({
              dato,
              restaurant: rest.name,
              loen: Math.round(d.loen * 100) / 100,
              timer: Math.round(d.timer * 10) / 10,
              medarbejdere: d.medarbejdere.size,
            });
            loenCount++;
          }
        } catch (e) {
          // Kvartal uden data
        }
        await new Promise(r => setTimeout(r, 200));
      }
    }
    console.log(`  Løn: ${loenCount} dage`);
  }

  // Gem i Supabase
  console.log(`\n💾 Gemmer ${allBudget.length} budget-rækker...`);
  if (allBudget.length > 0) await upsertBatch('budget', allBudget);
  console.log('✅ Budget gemt!');

  console.log(`💾 Gemmer ${allLoen.length} løn-rækker...`);
  if (allLoen.length > 0) await upsertBatch('loen', allLoen);
  console.log('✅ Løn gemt!');

  console.log('\n🎉 Backfill færdig!');
}

main().catch(e => { console.error('❌ Fatal fejl:', e); process.exit(1); });
