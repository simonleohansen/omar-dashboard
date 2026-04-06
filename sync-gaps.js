// ================================================================
// sync-gaps.js — Re-synker manglende datoer via Vercel endpoint
//
// Kalder /api/sync-supabase?run=now&dato=YYYY-MM-DD for hver dato
// der har salgsdata men mangler reservationsdata i Supabase.
//
// Kør: node sync-gaps.js
// ================================================================

const VERCEL_URL = 'https://omar-dashboard-seven.vercel.app';

// Alle unikke datoer der mangler reservationsdata (fundet via Supabase query)
const MANGLENDE_DATOER = [
  // Januar 2026
  '2026-01-03','2026-01-06','2026-01-07','2026-01-09','2026-01-10',
  '2026-01-16','2026-01-17','2026-01-18','2026-01-19','2026-01-20',
  '2026-01-26','2026-01-27','2026-01-28','2026-01-29','2026-01-30',
  // Februar 2026
  '2026-02-04','2026-02-05','2026-02-06','2026-02-07','2026-02-08',
  '2026-02-09','2026-02-14','2026-02-15','2026-02-16','2026-02-17',
  '2026-02-18','2026-02-19','2026-02-23','2026-02-26','2026-02-27',
  // Marts 2026
  '2026-03-01','2026-03-06','2026-03-08','2026-03-09','2026-03-10',
  '2026-03-11','2026-03-16','2026-03-18','2026-03-19','2026-03-20',
  '2026-03-21','2026-03-25','2026-03-26','2026-03-28','2026-03-29',
  '2026-03-30',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function syncDato(dato) {
  const url = `${VERCEL_URL}/api/sync-supabase?run=now&dato=${dato}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return { ok: false, status: r.status };
    const data = await r.json();
    const resAntal = (data.reservationer || []).length;
    return { ok: true, reservationer: resAntal };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function main() {
  console.log(`\n🔄 Synker ${MANGLENDE_DATOER.length} manglende datoer...\n`);

  let ok = 0, tomme = 0, fejl = 0;

  for (let i = 0; i < MANGLENDE_DATOER.length; i++) {
    const dato = MANGLENDE_DATOER[i];
    const result = await syncDato(dato);

    if (result.ok) {
      if (result.reservationer > 0) {
        console.log(`  ✅ ${dato} — ${result.reservationer} restauranter med reservationsdata`);
        ok++;
      } else {
        console.log(`  ○  ${dato} — ingen reservationer (EasyTable tom)`);
        tomme++;
      }
    } else {
      console.log(`  ❌ ${dato} — fejl: ${result.status || result.error}`);
      fejl++;
    }

    // 1 sekunds pause mellem hvert kald
    if (i < MANGLENDE_DATOER.length - 1) await sleep(1000);
  }

  console.log(`\n✅ Færdig!`);
  console.log(`  Med data:     ${ok} datoer`);
  console.log(`  Tom (0 res):  ${tomme} datoer`);
  console.log(`  Fejl:         ${fejl} datoer`);

  if (fejl > 0) {
    console.log(`\n  ℹ️  Kør scriptet igen hvis der var fejl — de fleste fejl er midlertidige.`);
  }
}

main().catch(e => { console.error('❌ Fatal fejl:', e); process.exit(1); });
