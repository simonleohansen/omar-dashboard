export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const RESTAURANTS = [
  { name: 'OMAR',   apiKey: 'ad772f86432144043c90f43f1ae452b1c5b7b9ed1513ba47d7b43d2b676c5afc', placeToken: '86D311B7-F65A-4F7E-8FC1-A34BC7D105CF' },
  { name: 'Safari', apiKey: '44de62dc484594986dceecf249b78ad7958fb3451a565b703815f6d974c60813', placeToken: '6DEA41E5-01BF-4185-859E-7D429E52E374' },
  { name: 'Lamar',  apiKey: '26eab9decc7f20f9b22b70ce7b4db0a30c33e2f9b55f6cbbe8f558e79f27fd47', placeToken: '7F804552-8F53-423C-8C7C-C9A2110A3EB0' },
  { name: 'Kima',   apiKey: '94741ca95a35b5599af0987bf6ae2a1a2341246df970f5ee0f2d0563f1b852a0', placeToken: '2EFEC917-6DCF-4017-9D1B-3BFB50D58ADA' },
];

const BASE = 'https://api.easytable.com/v2';

function toET(iso) {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

function dateRange(fraIso, tilIso) {
  const dates = [];
  const cur = new Date(fraIso);
  const end = new Date(tilIso);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

async function fetchOne(restaurant, dateIso) {
  const etDate = toET(dateIso);
  const headers = {
    'X-Api-Key': restaurant.apiKey,
    'X-Place-Token': restaurant.placeToken,
    'Accept': 'application/json',
  };
  try {
    // Brug /v2/bookings?date= endpoint — det returnerer individuelle bookinger
    // med status-felt, så vi kan filtrere korrekt (status "1" = bekræftet)
    const url = `${BASE}/bookings?date=${encodeURIComponent(etDate)}`;
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    const data = await r.json();
    const bookings = data.bookings || (Array.isArray(data) ? data : []);
    if (!bookings.length) return null;

    // Kun status "1" (bekræftede) — matcher Easytable UI
    const confirmed = bookings.filter(b => String(b.status) === '1');

    const gaester = confirmed.reduce((sum, b) => sum + (parseInt(b.persons) || 0), 0);
    const reservationer = confirmed.length;

    let frokost = 0, aften = 0;
    for (const b of confirmed) {
      const hour = parseInt((b.arrival || '').split(':')[0]) || 0;
      const persons = parseInt(b.persons) || 0;
      if (hour < 15) frokost += persons;
      else aften += persons;
    }

    return {
      gaester,
      reservationer,
      frokost,
      aften,
      gaesterGns:    0,
      reservGns:     0,
    };
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Understøt to modes:
  // 1. ?dates=2026-03-29,2026-03-22,2026-03-15  (liste af specifikke datoer)
  // 2. ?fromDate=2026-03-01&toDate=2026-03-29   (interval — max 30 dage)
  let dates = [];

  if (req.query.dates) {
    dates = req.query.dates.split(',').map(d => d.trim()).filter(Boolean);
  } else {
    const today = new Date().toISOString().slice(0, 10);
    const fraIso = req.query.fromDate || today;
    const tilIso = req.query.toDate   || today;
    dates = dateRange(fraIso, tilIso);
    if (dates.length > 120) {
      return res.status(400).json({ error: 'Max 120 dage ad gangen. Brug ?dates= for specifikke datoer.' });
    }
  }

  const restauranter = {};
  for (const r of RESTAURANTS) restauranter[r.name] = {};

  // Hent alle kombinationer parallelt
  const jobs = [];
  for (const r of RESTAURANTS) {
    for (const dato of dates) {
      jobs.push(
        fetchOne(r, dato).then(data => {
          if (data && (data.gaester > 0 || data.reservationer > 0)) {
            restauranter[r.name][dato] = data;
          }
        })
      );
    }
  }
  await Promise.all(jobs);

  return res.status(200).json({ restauranter });
}
