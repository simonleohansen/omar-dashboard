// ================================================================
// backfill-missing.js — Henter kun datoer der mangler i Supabase
//
// Spørger Supabase om hvilke dato/restaurant kombinationer der har
// salgsdata men mangler reservationsdata, og henter præcis dem.
//
// Kør: node backfill-missing.js
// ================================================================

const SUPABASE_URL = 'https://uhdvgerbiviephxmvqyq.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoZHZnZXJiaXZpZXBoeG12cXlxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDk5NTA4MiwiZXhwIjoyMDkwNTcxMDgyfQ.pxes28W-POgitAeL3ERujWoX94rktm0liigDEV8bMsY';

const ET_RESTAURANTS = [
  { name: 'OMAR',   apiKey: 'ad772f86432144043c90f43f1ae452b1c5b7b9ed1513ba47d7b43d2b676c5afc', placeToken: '86D311B7-F65A-4F7E-8FC1-A34BC7D105CF' },
  { name: 'Safari', apiKey: '44de62dc484594986dceecf249b78ad7958fb3451a565b703815f6d974c60813', placeToken: '6DEA41E5-01BF-4185-859E-7D429E52E374' },
  { name: 'Lamar',  apiKey: '26eab9decc7f20f9b22b70ce7b4db0a30c33e2f9b55f6cbbe8f558e79f27fd47', placeToken: '7F804552-8F53-423C-8C7C-C9A2110A3EB0' },
  { name: 'Kima',   apiKey: '94741ca95a35b5599af0987bf6ae2a1a2341246df970f5ee0f2d0563f1b852a0', placeToken: '2EFEC917-6DCF-4017-9D1B-3BFB50D58ADA' },
];

// Hent manglende dato/restaurant kombinationer fra Supabase via RPC
async function hentManglende() {
  const sql = `
    WITH salg_datoer AS (
      SELECT DISTINCT dato, restaurant FROM salg WHERE dato >= '2023-01-01'
    ),
    res_datoer AS (
      SELECT DISTINCT dato, restaurant FROM reservationer
    )
    SELECT s.dato, s.restaurant
    FROM salg_datoer s
    LEFT JOIN res_datoer r ON s.dato = r.dato AND s.restaurant = r.restaurant
    WHERE r.dato IS NULL
      AND s.dato <= CURRENT_DATE - INTERVAL '1 day'
    ORDER BY s.dato, s.restaurant
  `;

  // Brug Supabase REST API med SQL via RPC
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/execute_sql`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });

  if (!r.ok) {
    // Fallback: hent via to separate queries og sammenlign
    return null;
  }
  return await r.json();
}

// Hent manglende via pagination fra begge tabeller
async function hentManglendeViaTabeller() {
  console.log('Henter salgsdata fra Supabase...');

  // Hent alle (dato, restaurant) fra salg
  let salgRows = [];
  let offset = 0;
  while (true) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/salg?select=dato,restaurant&dato=gte.2023-01-01&order=dato,restaurant&limit=1000&offset=${offset}`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    salgRows = salgRows.concat(rows);
    if (rows.length < 1000) break;
    offset += 1000;
  }
  console.log(`  ${salgRows.length} salgsrækker fundet`);

  // Hent alle (dato, restaurant) fra reservationer
  let resRows = [];
  offset = 0;
  while (true) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/reservationer?select=dato,restaurant&order=dato,restaurant&limit=1000&offset=${offset}`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    resRows = resRows.concat(rows);
    if (rows.length < 1000) break;
    offset += 1000;
  }
  console.log(`  ${resRows.length} reservationsrækker fundet`);

  // Find manglende
  const resSet = new Set(resRows.map(r => `${r.dato}|${r.restaurant}`));
  const igaar = new Date(); igaar.setDate(igaar.getDate() - 1);
  const igaarStr = igaar.toISOString().slice(0, 10);

  const manglende = salgRows
    .filter(s => s.dato <= igaarStr && !resSet.has(`${s.dato}|${s.restaurant}`))
    .map(s => ({ dato: s.dato, restaurant: s.restaurant }));

  return manglende;
}

// Hent EasyTable data for én restaurant og én dato
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
    if (!bookings.length) return { gaester: 0, reservationer: 0, no_shows: 0, frokost: 0, aften: 0 };

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
  } catch (e) {
    return null; // fejl — prøv igen ved næste kørsel
  }
}

// Gem batch i Supabase
async function upsertBatch(rows) {
  if (!rows.length) return;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/reservationer?on_conflict=dato,restaurant`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) {
    const err = await r.text();
    console.warn(`  ⚠️  Supabase upsert fejl: ${r.status} ${err}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('\n🔍 Finder manglende reservationsdata...\n');

  const manglende = await hentManglendeViaTabeller();
  console.log(`\n📋 ${manglende.length} manglende dato/restaurant kombinationer\n`);

  if (!manglende.length) {
    console.log('✅ Ingen huller fundet!');
    return;
  }

  // Gruppér pr. restaurant for at vise progress
  const prRest = {};
  for (const m of manglende) {
    if (!prRest[m.restaurant]) prRest[m.restaurant] = [];
    prRest[m.restaurant].push(m.dato);
  }
  for (const [rest, datoer] of Object.entries(prRest)) {
    console.log(`  ${rest}: ${datoer.length} manglende datoer (${datoer[0]} → ${datoer[datoer.length-1]})`);
  }
  console.log('');

  // Behandl én ad gangen med god pause for at undgå rate limiting
  const BATCH_SIZE = 5; // 5 kombinationer ad gangen
  const PAUSE_MS = 600;  // 600ms pause — roligere end backfill.js

  let gemt = 0;
  let fejl = 0;
  let tomme = 0;
  const batch = [];

  for (let i = 0; i < manglende.length; i++) {
    const { dato, restaurant } = manglende[i];
    const etRest = ET_RESTAURANTS.find(r => r.name === restaurant);
    if (!etRest) { fejl++; continue; }

    const data = await hentEasytable(etRest, dato);

    if (data === null) {
      fejl++;
    } else {
      batch.push({ dato, restaurant, ...data });
      if (data.gaester > 0) gemt++;
      else tomme++;
    }

    // Gem batch
    if (batch.length >= BATCH_SIZE || i === manglende.length - 1) {
      await upsertBatch(batch);
      batch.length = 0;
    }

    // Progress hvert 50. element
    if ((i + 1) % 50 === 0 || i === manglende.length - 1) {
      process.stdout.write(`  ${i + 1}/${manglende.length} — gemt: ${gemt}, tomme: ${tomme}, fejl: ${fejl}\n`);
    }

    await sleep(PAUSE_MS);
  }

  console.log(`\n🎉 Færdig!`);
  console.log(`  ✅ Med gæster: ${gemt}`);
  console.log(`  ○  Tomme (0 gæster): ${tomme}`);
  console.log(`  ⚠️  Fejl: ${fejl}`);
}

main().catch(e => { console.error('❌ Fatal fejl:', e); process.exit(1); });
