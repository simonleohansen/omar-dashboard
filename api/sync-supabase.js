// ================================================================
// api/sync-supabase.js — Daglig sync af salgs- og reservationsdata
//
// Kører hver dag kl. 06:00 via Vercel Cron.
// Henter gårsdagens data fra OnlinePOS + Easytable og gemmer i Supabase.
//
// Miljøvariabler (sættes i Vercel):
//   SUPABASE_URL         — https://uhdvgerbiviephxmvqyq.supabase.co
//   SUPABASE_SERVICE_KEY  — service role key
//
// Manuel kørsel: GET /api/sync-supabase?run=now
// Specifik dato: GET /api/sync-supabase?run=now&dato=2026-03-30
// ================================================================

export const config = { api: { bodyParser: false } };

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

// Restaurantdag: 02:00-01:59. Salg kl. 00:00-01:59 tilhører dagen før.
function korrektDatoSync(dateStr, timeStr) {
  const hh = parseInt((timeStr || '').split(':')[0]) || 0;
  if (hh < 2) {
    const m = dateStr.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m) {
      const d = new Date(`${m[3]}-${m[2]}-${m[1]}T12:00:00`);
      d.setDate(d.getDate() - 1);
      return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
    }
  }
  return dateStr;
}

// Hent salgsdata fra OnlinePOS for én restaurant og én dato
async function hentSalg(rest, dato) {
  // Hent 2 timer ekstra bagud for at fange salg efter midnat
  const fromUnix = toUnixDK(dato, false) - (2 * 3600);
  // Hent til kl. 01:59 næste dag (de tilhører stadig denne dag)
  const toUnix = toUnixDK(dato, true) + (2 * 3600);
  try {
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
    if (!data.sales) return { omsaetning: 0, pax: 0 };

    let omsaetning = 0;
    const checks = {};
    for (const item of data.sales) {
      const l = item.line || item;
      // Korriger dato: salg kl. 00:00-01:59 tilhører dagen før
      const rigtigDato = korrektDatoSync(l.date || '', l.time || '');
      const m = rigtigDato.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      if (!m) continue;
      const iso = `${m[3]}-${m[2]}-${m[1]}`;
      if (iso !== dato) continue;

      omsaetning += parseFloat((l.price || '0').toString().replace(',', '.')) || 0;
      const px = parseInt(l.pax) || 0;
      const chk = String(l.chk || '');
      if (px > 0 && chk) {
        if ((checks[chk] || 0) < px) checks[chk] = px;
      }
    }
    const pax = Object.values(checks).reduce((a, b) => a + b, 0);
    return { omsaetning: Math.round(omsaetning * 100) / 100, pax };
  } catch (e) {
    return { omsaetning: 0, pax: 0 };
  }
}

// Hent reservationsdata fra Easytable for én restaurant og én dato
// Bruger /v2/bookings?date= endpoint med status-filtrering:
//   status "1" = bekræftede/ankomne (matcher Easytable UI tal)
//   status "2" = aflyst/no-show (ekskluderes)
async function hentReservation(rest, dato) {
  const [y, m, d] = dato.split('-');
  const etDate = `${m}/${d}/${y}`;  // MM/DD/YYYY format
  try {
    const r = await fetch(`https://api.easytable.com/v2/bookings?date=${encodeURIComponent(etDate)}`, {
      headers: {
        'X-Api-Key': rest.apiKey,
        'X-Place-Token': rest.placeToken,
        'Accept': 'application/json',
      }
    });
    if (!r.ok) return null;
    const data = await r.json();
    const bookings = data.bookings || (Array.isArray(data) ? data : []);
    if (!bookings.length) return null;

    // Kun status "1" (bekræftede) — matcher Easytable UI
    const confirmed = bookings.filter(b => String(b.status) === '1');
    const cancelled = bookings.filter(b => String(b.status) === '2');

    const gaester = confirmed.reduce((sum, b) => sum + (parseInt(b.persons) || 0), 0);
    const reservationer = confirmed.length;
    const no_shows = cancelled.length;

    // Opdel i frokost/aften baseret på ankomsttid
    let frokost = 0, aften = 0;
    for (const b of confirmed) {
      const hour = parseInt((b.arrival || '').split(':')[0]) || 0;
      const persons = parseInt(b.persons) || 0;
      if (hour < 15) frokost += persons;
      else aften += persons;
    }

    return { gaester, reservationer, no_shows, frokost, aften };
  } catch (e) {
    return null;
  }
}

// Upsert til Supabase
async function upsert(table, rows) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/${table}?on_conflict=dato,restaurant`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Supabase ${table} upsert fejl: ${r.status} ${err}`);
  }
}

// Find manglende datoer i Supabase for de seneste N dage
async function findManglendeDatoer(antalDage) {
  const idag = new Date();
  const datoer = [];
  for (let i = 1; i <= antalDage; i++) {
    const d = new Date(idag);
    d.setDate(d.getDate() - i);
    datoer.push(d.toISOString().slice(0, 10));
  }
  // Tjek hvilke der mangler i Supabase
  const url = `${process.env.SUPABASE_URL}/rest/v1/salg?select=dato&dato=in.(${datoer.map(d=>`"${d}"`).join(',')})`;
  const r = await fetch(url, {
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    }
  });
  if (!r.ok) return [datoer[0]]; // fallback til i går
  const data = await r.json();
  const harData = new Set(data.map(row => row.dato));
  return datoer.filter(d => !harData.has(d));
}

async function syncDato(dato) {
  const [salgData, resData] = await Promise.all([
    Promise.all(RESTAURANTS.map(async r => {
      const d = await hentSalg(r, dato);
      return { dato, restaurant: r.name, ...d };
    })),
    Promise.all(ET_RESTAURANTS.map(async r => {
      const d = await hentReservation(r, dato);
      return d ? { dato, restaurant: r.name, ...d } : null;
    })),
  ]);
  const salg = salgData;
  const reservationer = resData.filter(Boolean);
  const errors = [];
  try { await upsert('salg', salg); } catch (e) { errors.push(e.message); }
  if (reservationer.length > 0) {
    try { await upsert('reservationer', reservationer); } catch (e) { errors.push(e.message); }
  }
  return { dato, salg, reservationer, errors };
}

export default async function handler(req, res) {
  const erCron = req.headers['x-vercel-cron'] === '1';
  const erManuel = req.method === 'GET' && req.query.run === 'now';
  if (!erCron && !erManuel) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Specifik dato: kun én dato
  if (req.query.dato) {
    const resultat = await syncDato(req.query.dato);
    return res.status(200).json({
      success: resultat.errors.length === 0,
      ...resultat,
    });
  }

  // Cron / manuel uden dato: sync i går + catch-up for eventuelle manglende dage (op til 5 dage tilbage)
  const manglende = await findManglendeDatoer(5);
  if (manglende.length === 0) {
    // Intet mangler — sync i går alligevel (overskriv med opdaterede tal)
    const igaar = new Date();
    igaar.setDate(igaar.getDate() - 1);
    manglende.push(igaar.toISOString().slice(0, 10));
  }

  const alleResultater = [];
  for (const dato of manglende) {
    const r = await syncDato(dato);
    alleResultater.push(r);
  }

  const errors = alleResultater.flatMap(r => r.errors);
  return res.status(200).json({
    success: errors.length === 0,
    synkede: alleResultater.map(r => r.dato),
    resultater: alleResultater,
    errors: errors.length > 0 ? errors : undefined,
  });
}
