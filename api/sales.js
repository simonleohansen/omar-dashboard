// ================================================================
// api/sales.js — Omar Gruppen Vercel proxy
//
// Restaurantdag slutter kl. 02:00 — salg mellem 00:00-01:59
// tilhører den foregående kalenderdag.
// ================================================================

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { firmaid, token, fromDate, toDate } = req.body || {};
  if (!firmaid || !token || !fromDate || !toDate) {
    return res.status(400).json({ error: 'Missing required fields', received: JSON.stringify(req.body) });
  }

  function toUnixDK(dateStr, endOfDay) {
    const timeStr = endOfDay ? 'T23:59:59' : 'T00:00:00';
    const month = parseInt(dateStr.split('-')[1]);
    const offset = (month >= 4 && month <= 9) ? '+02:00' : '+01:00';
    return Math.floor(new Date(dateStr + timeStr + offset).getTime() / 1000);
  }

  // Restaurantdag: 02:00-01:59. Salg kl. 00:00-01:59 tilhører dagen før.
  function korrektDato(dateStr, timeStr) {
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

  // Hent 2 timer ekstra bagud for at fange salg efter midnat
  const fromUnix = toUnixDK(fromDate, false) - (2 * 3600);
  const toUnix   = toUnixDK(toDate, true);

  try {
    const response = await fetch('https://api.onlinepos.dk/api/exportSales', {
      method: 'POST',
      headers: {
        'token':        String(token),
        'firmaid':      String(firmaid),
        'Accept':       'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `from=${fromUnix}&to=${toUnix}`
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { return res.status(200).send(text); }

    if (!data.sales) return res.status(200).json(data);

    // Korriger dato og filtrer til ønsket periode
    const korrigeret = data.sales.map(item => {
      const l = item.line || item;
      return { line: { ...l, date: korrektDato(l.date || '', l.time || '') } };
    });

    const filtreret = korrigeret.filter(item => {
      const l = item.line;
      const m = (l.date||'').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      if (!m) return false;
      const iso = `${m[3]}-${m[2]}-${m[1]}`;
      return iso >= fromDate && iso <= toDate;
    });

    return res.status(200).json({ sales: filtreret });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
