// ================================================================
// backfill.js — Engangs-script: fyld Supabase med 700 dages historik
//
// Kør: node backfill.js
// Eller specifik periode: node backfill.js 2024-06-01 2026-03-31
// ================================================================

const SUPABASE_URL = 'https://uhdvgerbiviephxmvqyq.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoZHZnZXJiaXZpZXBoeG12cXlxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDk5NTA4MiwiZXhwIjoyMDkwNTcxMDgyfQ.pxes28W-POgitAeL3ERujWoX94rktm0liigDEV8bMsY';

const RESTAURANTS = [
  { name: 'OMAR',   firmaid: 13438, token: 'e97ee86e7d88c54c1ca3d0b5b5eed3c95a4eda0d05a448958ebde5e80d9c6ba9' },
  { name: 'Safari', firmaid: 12510, token: '628633d366d5a569c91116ed0ae281db5402755f298d8ebf07691c19107ce587' },
  { name: 'Lamar',  firmaid: 15123, token: 'f6b5780221629ae89c5e47873cfbbc93dda6da2873a7aed283da3c01ae558ac3' },
  { name: 'Kima',   firmaid: 18089, token: '1504ee0a3000257fe676b37c66edf37feb2a3a592829c84a31f7e428b1073b17' },
];

const ET_RESTAURANTS = [
  { name: 'OMAR',   apiKey: 'ad772f86432144043c90f43f1ae452b1c5b7b9ed1513ba47d7b43d2b676c5afc', placeToken: '86D311B7-F65A-4F7E-8FC1-A34BC7D105CF' },
  { name: 'Safari', apiKey: '44de62dc484594986dceecf249b78ad7958fb3451a565b703815f6d974c60813', placeToken: '6DEA41E5-01BF-4185-859E-7D429E52E374' },
  { name: 'Lamar',  apiKey: '26eab9decc7f20f9b22b70ce7b4db0a30c33e2f9b55f6cbbe8f558e79f27fd47', placeToken: '7F804552-8F53-423C-8C7C-C9A2110A3EB0' },
  { name: 'Kima',   apiKey: '94741ca95a35b5599af0987bf6ae2a1a2341246df970f5ee0f2d0563f1b852a0', placeToken: '2EFEC917-6DCF-4017-9D1B-3BFB50D58ADA' },
];

function toUnixDK(dateStr, endOfDay) {
  const timeStr = endOfDay ? 'T23:59:59' : 'T00:00:00';
  const month = parseInt(dateStr.split('-')[1]);
  const offset = (month >= 4 && month <= 9) ? '+02:00' : '+01:00';
  return Math.floor(new Date(dateStr + timeStr + offset).getTime() / 1000);
}

function korrektDato(dateStr, timeStr) {
  const hh = parseInt((timeStr || '').split(':')[0]) || 0;
  if (hh >= 0 && hh < 6) {
    const m = dateStr.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m) {
      const d = new Date(`${m[3]}-${m[2]}-${m[1]}T12:00:00`);
      d.setDate(d.getDate() - 1);
      return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
    }
  }
  return dateStr;
}

function dateRange(from, to) {
  const dates = [];
  const cur = new Date(from + 'T12:00:00');
  const end = new Date(to + 'T12:00:00');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// Opdel periode i 90-dages chunks
function chunks(from, to) {
  const result = [];
  const cur = new Date(from + 'T12:00:00');
  const end = new Date(to + 'T12:00:00');
  while (cur <= end) {
    const chunkEnd = new Date(cur);
    chunkEnd.setDate(chunkEnd.getDate() + 89);
    const actualEnd = chunkEnd > end ? end : chunkEnd;
    result.push({ from: cur.toISOString().slice(0, 10), to: actualEnd.toISOString().slice(0, 10) });
    cur.setTime(actualEnd.getTime());
    cur.setDate(cur.getDate() + 1);
  }
  return result;
}

// Hent salgsdata fra OnlinePOS for ét chunk
async function hentSalgChunk(rest, from, to) {
  const fromUnix = toUnixDK(from, false) - (6 * 3600);
  const toUnix = toUnixDK(to, true);
  const r = await fetch('https://api.onlinepos.dk/api/exportSales', {
    method: 'POST',
    headers: {
      'token': String(rest.token),
      'firmaid': String(rest.firmaid),
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: `from=${fromUnix}&to=${toUnix}`
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error);
  return data.sales || [];
}

// Hent Easytable for én dato — bruger /v2/bookings med status-filtrering (samme som sync-supabase.js)
async function hentEasytable(rest, dato) {
  const [y, m, d] = dato.split('-');
  const etDate = `${m}/${d}/${y}`;
  try {
    const r = await fetch(`https://api.easytable.com/v2/bookings?date=${encodeURIComponent(etDate)}`, {
      headers: { 'X-Api-Key': rest.apiKey, 'X-Place-Token': rest.placeToken, 'Accept': 'application/json' }
    });
    if (!r.ok) return null;
    const data = await r.json();
    const bookings = data.bookings || (Array.isArray(data) ? data : []);
    if (!bookings.length) return null;

    const confirmed = bookings.filter(b => String(b.status) === '1');
    const cancelled = bookings.filter(b => String(b.status) === '2');

    const gaester = confirmed.reduce((sum, b) => sum + (parseInt(b.persons) || 0), 0);
    const reservationer = confirmed.length;
    const no_shows = cancelled.length;

    let frokost = 0, aften = 0;
    for (const b of confirmed) {
      const hour = parseInt((b.arrival || '').split(':')[0]) || 0;
      const persons = parseInt(b.persons) || 0;
      if (hour < 15) frokost += persons;
      else aften += persons;
    }

    return { gaester, reservationer, no_shows, frokost, aften };
  } catch { return null; }
}

// Upsert batch til Supabase (max 500 rækker ad gangen)
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
  const args = process.argv.slice(2);
  const to = args[1] || new Date(Date.now() - 86400000).toISOString().slice(0, 10); // i går
  const from = args[0] || (() => { const d = new Date(); d.setDate(d.getDate() - 700); return d.toISOString().slice(0, 10); })();

  console.log(`\n📦 Backfill: ${from} → ${to}\n`);

  // ── SALGSDATA FRA ONLINEPOS ──────────────────────────
  const allSalg = []; // { dato, restaurant, omsaetning, pax }

  for (const rest of RESTAURANTS) {
    const chs = chunks(from, to);
    console.log(`🔄 ${rest.name}: henter ${chs.length} chunks...`);

    // daglig aggregering: { dato: { omsaetning, checks: { chk: maxPax } } }
    const daglig = {};

    for (let i = 0; i < chs.length; i++) {
      const ch = chs[i];
      try {
        const sales = await hentSalgChunk(rest, ch.from, ch.to);
        for (const item of sales) {
          const l = item.line || item;
          // Restaurantdag: salg kl. 00:00-01:59 tilhører dagen før (matcher kasserapport)
          const hh = parseInt((l.time || '').split(':')[0]) || 0;
          let datStr = l.date || '';
          if (hh < 2) {
            const mx = datStr.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
            if (mx) { const dd = new Date(`${mx[3]}-${mx[2]}-${mx[1]}T12:00:00`); dd.setDate(dd.getDate()-1); datStr = `${String(dd.getDate()).padStart(2,'0')}.${String(dd.getMonth()+1).padStart(2,'0')}.${dd.getFullYear()}`; }
          }
          const m = datStr.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
          if (!m) continue;
          const iso = `${m[3]}-${m[2]}-${m[1]}`;
          if (iso < from || iso > to) continue;

          if (!daglig[iso]) daglig[iso] = { omsaetning: 0, checks: {} };
          daglig[iso].omsaetning += parseFloat((l.price || '0').toString().replace(',', '.')) || 0;

          const px = parseInt(l.pax) || 0;
          const chk = String(l.chk || '');
          if (px > 0 && chk) {
            if ((daglig[iso].checks[chk] || 0) < px) daglig[iso].checks[chk] = px;
          }
        }
        process.stdout.write(`  chunk ${i + 1}/${chs.length} (${ch.from} → ${ch.to}): ${sales.length} linjer\n`);
      } catch (e) {
        console.warn(`  ⚠️  chunk ${i + 1} fejl: ${e.message}`);
      }
      // Lille pause mellem chunks
      await new Promise(r => setTimeout(r, 200));
    }

    // Konverter til rækker
    for (const [dato, d] of Object.entries(daglig)) {
      const pax = Object.values(d.checks).reduce((a, b) => a + b, 0);
      allSalg.push({
        dato,
        restaurant: rest.name,
        omsaetning: Math.round(d.omsaetning * 100) / 100,
        pax
      });
    }
    console.log(`  ✅ ${rest.name}: ${Object.keys(daglig).length} dage aggregeret\n`);
  }

  // Gem salg i Supabase
  console.log(`💾 Gemmer ${allSalg.length} salgs-rækker i Supabase...`);
  await upsertBatch('salg', allSalg);
  console.log(`✅ Salg gemt!\n`);

  // ── EASYTABLE RESERVATIONER ──────────────────────────
  const allDates = dateRange(from, to);
  const allRes = [];
  console.log(`🔄 Easytable: henter reservationer for ${allDates.length} dage...`);

  // Hent i batches af 10 dage for at undgå rate limiting
  for (let i = 0; i < allDates.length; i += 10) {
    const batch = allDates.slice(i, i + 10);
    const jobs = [];
    for (const dato of batch) {
      for (const rest of ET_RESTAURANTS) {
        jobs.push(
          hentEasytable(rest, dato).then(d => {
            if (d && (d.gaester > 0 || d.reservationer > 0)) {
              allRes.push({ dato, restaurant: rest.name, ...d });
            }
          })
        );
      }
    }
    await Promise.all(jobs);
    process.stdout.write(`  ${Math.min(i + 10, allDates.length)}/${allDates.length} dage\r`);
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`\n  ✅ ${allRes.length} reservations-rækker fundet\n`);

  if (allRes.length > 0) {
    console.log(`💾 Gemmer ${allRes.length} reservations-rækker i Supabase...`);
    await upsertBatch('reservationer', allRes);
    console.log(`✅ Reservationer gemt!\n`);
  }

  console.log('🎉 Backfill færdig!');
}

main().catch(e => { console.error('❌ Fatal fejl:', e); process.exit(1); });
