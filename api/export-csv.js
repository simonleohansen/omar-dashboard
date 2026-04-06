// ================================================================
// api/export-csv.js — Omar Gruppen ugentlig CSV-eksport
//
// Kalder OnlinePOS for alle fire restauranter og returnerer
// en aggregeret CSV med daglige omsætningstal.
//
// Brug:
//   GET /api/export-csv?fromDate=2026-03-24&toDate=2026-03-30
//   GET /api/export-csv  (ingen parametre = sidste 7 dage)
// ================================================================

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const RESTAURANTS = [
  { name: 'OMAR',   firmaid: 13438, token: 'e97ee86e7d88c54c1ca3d0b5b5eed3c95a4eda0d05a448958ebde5e80d9c6ba9' },
  { name: 'Safari', firmaid: 12510, token: '628633d366d5a569c91116ed0ae281db5402755f298d8ebf07691c19107ce587' },
  { name: 'Lamar',  firmaid: 15123, token: 'f6b5780221629ae89c5e47873cfbbc93dda6da2873a7aed283da3c01ae558ac3' },
  { name: 'Kima',   firmaid: 18089, token: '1504ee0a3000257fe676b37c66edf37feb2a3a592829c84a31f7e428b1073b17' },
];

// Dansk tidszone offset (vinter: +1, sommer: +2)
function toUnixDK(dateStr, endOfDay) {
  const timeStr = endOfDay ? 'T23:59:59' : 'T00:00:00';
  const month = parseInt(dateStr.split('-')[1]);
  const offset = (month >= 4 && month <= 9) ? '+02:00' : '+01:00';
  return Math.floor(new Date(dateStr + timeStr + offset).getTime() / 1000);
}

// Korriger natlukkede salg (00:00-05:59 tilhører dagen FØR)
function korrektDato(dateStr, timeStr) {
  const timeDel = (timeStr || '').split(':');
  const hh = parseInt(timeDel[0]) || 0;
  if (hh >= 0 && hh < 6) {
    const m = dateStr.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (m) {
      const d = new Date(`${m[3]}-${m[2]}-${m[1]}T12:00:00`);
      d.setDate(d.getDate() - 1);
      const dag = String(d.getDate()).padStart(2, '0');
      const mnd = String(d.getMonth() + 1).padStart(2, '0');
      const aar = d.getFullYear();
      return `${dag}.${mnd}.${aar}`;
    }
  }
  return dateStr;
}

// Konverter DD.MM.YYYY til YYYY-MM-DD
function toISO(dateStr) {
  const m = dateStr.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// Hent og aggreger salgsdata for én restaurant
async function hentRestaurant(rest, fromDate, toDate) {
  const fromUnix = toUnixDK(fromDate, false) - (6 * 3600); // 6t ekstra for natlukning
  const toUnix   = toUnixDK(toDate, true);

  const response = await fetch('https://api.onlinepos.dk/api/exportSales', {
    method: 'POST',
    headers: {
      'token':        String(rest.token),
      'firmaid':      String(rest.firmaid),
      'Accept':       'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: `from=${fromUnix}&to=${toUnix}`
  });

  const data = await response.json();
  if (!data.sales) return {};

  // Aggreger omsætning per dag
  const daglig = {};
  for (const item of data.sales) {
    const l = item.line || item;
    const dato = korrektDato(l.date || '', l.time || '');
    const iso  = toISO(dato);
    if (!iso || iso < fromDate || iso > toDate) continue;

    if (!daglig[iso]) daglig[iso] = { omsaetning: 0, transaktioner: 0 };
    const pris = parseFloat((l.price || '0').toString().replace(',', '.')) || 0;
    daglig[iso].omsaetning    += pris;
    daglig[iso].transaktioner += 1;
  }
  return daglig;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Standardperiode: sidste 7 dage hvis ingen parametre
  const idag = new Date();
  const defaultTil = idag.toISOString().split('T')[0];
  const defaultFra = new Date(idag - 7 * 86400000).toISOString().split('T')[0];

  const fromDate = req.query.fromDate || defaultFra;
  const toDate   = req.query.toDate   || defaultTil;

  // Byg liste af alle datoer i perioden
  const datoer = [];
  const d = new Date(fromDate);
  const slut = new Date(toDate);
  while (d <= slut) {
    datoer.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 1);
  }

  // Hent data for alle restauranter parallelt
  const resultater = await Promise.all(
    RESTAURANTS.map(r => hentRestaurant(r, fromDate, toDate))
  );

  // Byg CSV
  const linjer = [];

  // Header
  const kolonner = ['Dato', 'Dag'];
  for (const r of RESTAURANTS) {
    kolonner.push(`${r.name}_omsaetning`, `${r.name}_transaktioner`);
  }
  kolonner.push('Total_omsaetning', 'Total_transaktioner');
  linjer.push(kolonner.join(';'));

  // Ugedagsnavne på dansk
  const DAGE = ['Søndag', 'Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag'];

  // En linje per dato
  let totalOmsaetning = 0;
  let totalTransaktioner = 0;

  for (const dato of datoer) {
    const dagNr   = new Date(dato).getDay();
    const dagNavn = DAGE[dagNr];
    const linje   = [dato, dagNavn];

    let dagsTotal = 0;
    let dagsTrans  = 0;

    for (const res of resultater) {
      const d = res[dato] || { omsaetning: 0, transaktioner: 0 };
      linje.push(
        Math.round(d.omsaetning).toString(),
        d.transaktioner.toString()
      );
      dagsTotal += d.omsaetning;
      dagsTrans  += d.transaktioner;
    }

    linje.push(Math.round(dagsTotal).toString(), dagsTrans.toString());
    linjer.push(linje.join(';'));

    totalOmsaetning     += dagsTotal;
    totalTransaktioner  += dagsTrans;
  }

  // Totallinje
  const totalLinje = ['TOTAL', ''];
  for (const res of resultater) {
    const resTotal = Object.values(res).reduce((s, d) => s + d.omsaetning, 0);
    const resTrans = Object.values(res).reduce((s, d) => s + d.transaktioner, 0);
    totalLinje.push(Math.round(resTotal).toString(), resTrans.toString());
  }
  totalLinje.push(Math.round(totalOmsaetning).toString(), totalTransaktioner.toString());
  linjer.push(totalLinje.join(';'));

  const csv = linjer.join('\n');
  const filnavn = `omar-gruppen-salg-${fromDate}-til-${toDate}.csv`;

  // Returner som CSV-fil eller JSON afhængig af Accept-header
  const acceptHeader = req.headers['accept'] || '';
  if (acceptHeader.includes('application/json')) {
    return res.status(200).json({ fromDate, toDate, csv, linjer: linjer.length - 2 });
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filnavn}"`);
  return res.status(200).send('\uFEFF' + csv); // BOM for Excel-kompatibilitet
}
