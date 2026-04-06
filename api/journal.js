export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { firmaid, token, fromDate, toDate } = req.body || {};
  if (!firmaid || !token || !fromDate || !toDate) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Konverter dato til unix timestamp (dansk tid CET/CEST)
  function toUnixDK(dateStr, endOfDay) {
    const timeStr = endOfDay ? 'T23:59:59' : 'T00:00:00';
    const month = parseInt(dateStr.split('-')[1]);
    const offset = (month >= 4 && month <= 9) ? '+02:00' : '+01:00';
    return Math.floor(new Date(dateStr + timeStr + offset).getTime() / 1000);
  }

  // Beregn korrekt driftsdato fra bogføringsdatotid
  // Logik: hvis kassen lukkes mellem 00:00 og 06:00 dansk tid,
  // tilhører salget DAGEN FØR (natlukning)
  function driftsDato(bogfoertStr) {
    // bogfoertStr format: "28.03.2026 - 00:09" eller "28.03.2026 23:39"
    // Normaliser
    const cleaned = bogfoertStr.replace(' - ', ' ').trim();
    const m = cleaned.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
    if (!m) return null;

    const [, dag, mnd, aar, hh, mm] = m;
    const time = parseInt(hh);

    // Bogføringsdato som ISO
    const bogfoertDato = `${aar}-${mnd}-${dag}`;

    // Natlukning: bogført mellem 00:00 og 06:00 → salget tilhører dagen før
    if (time >= 0 && time < 6) {
      const d = new Date(bogfoertDato + 'T12:00:00');
      d.setDate(d.getDate() - 1);
      return d.toLocaleDateString('sv-SE');
    }

    return bogfoertDato;
  }

  // Hent 3 ekstra dage bagud for at fange natlukkede kasser
  // (en kasse lukket 28. marts kl 00:09 bogføres 28. marts men tilhører 27. marts)
  const fraUdvidet = toUnixDK(fromDate, false) - (3 * 24 * 3600);
  const to = toUnixDK(toDate, true);

  try {
    // Forsøg 1: GET /end_of_day_journal/{from}/{to}
    let raw = null;
    let source = '';

    const r1 = await fetch(
      `https://api.onlinepos.dk/api/end_of_day_journal/${fraUdvidet}/${to}`,
      { headers: { 'token': String(token), 'firmaid': String(firmaid), 'Accept': 'application/json' } }
    );
    const t1 = await r1.text();

    if (r1.ok && t1.length > 5 && !t1.toLowerCase().includes('invalid input')) {
      try { raw = JSON.parse(t1); source = 'GET /end_of_day_journal/{from}/{to}'; }
      catch { raw = t1; source = 'GET raw'; }
    }

    // Forsøg 2: POST med unix timestamps
    if (!raw) {
      const r2 = await fetch('https://api.onlinepos.dk/api/end_of_day_journal', {
        method: 'POST',
        headers: {
          'token': String(token), 'firmaid': String(firmaid),
          'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `from=${fraUdvidet}&to=${to}`
      });
      const t2 = await r2.text();
      if (r2.ok && t2.length > 5 && !t2.toLowerCase().includes('invalid')) {
        try { raw = JSON.parse(t2); source = 'POST /end_of_day_journal'; }
        catch { raw = t2; source = 'POST raw'; }
      }
    }

    // Returner rå data til debug hvis ingen parsing
    if (!raw) {
      return res.status(200).json({
        error: 'Ingen data fra end_of_day_journal',
        try1: { status: r1.status, body: t1.slice(0, 300) }
      });
    }

    // ── Parse kasserapporter ────────────────────────────────────
    // API returnerer sandsynligvis en liste af kasserapporter
    const rapporter = Array.isArray(raw) ? raw
      : (raw.journals || raw.journal || raw.reports || raw.data || raw.cashreports || []);

    if (!rapporter.length) {
      // Returner rå data så vi kan se strukturen
      return res.status(200).json({ source, rawStructure: raw });
    }

    // Byg dagsoversigt med korrekt driftsdato
    const dagData = {};

    for (const r of rapporter) {
      const rapport = r.journal || r.report || r.cashreport || r;

      // Bogføringsdato — vi justerer for natlukning
      const bogfoert = rapport.close_date || rapport.bogfoert || rapport.booked_date
        || rapport.date || rapport.closed || rapport.timestamp || '';

      const dato = driftsDato(String(bogfoert));
      if (!dato) continue;

      // Tjek at datoen er inden for vores ønskede interval
      if (dato < fromDate || dato > toDate) continue;

      // Total omsætning fra kasserapport
      // Prøver alle mulige feltnavne
      const totalRaw = rapport.total || rapport.sales_total || rapport.netsales
        || rapport.total_excl_vat || rapport.subtotal || rapport.amount
        || rapport.revenue || rapport.turnover || 0;
      const total = parseFloat(String(totalRaw).replace(',', '.').replace(/\./g, '').replace(',', '.')) || 0;

      // Pax
      const paxRaw = rapport.pax || rapport.guests || rapport.covers || rapport.antal_gaester || 0;
      const pax = parseInt(paxRaw) || 0;

      // Bilagsnummer til debug
      const bilag = rapport.receipt_no || rapport.bilag || rapport.journal_no || rapport.id || '?';

      if (!dagData[dato]) dagData[dato] = { omsætning: 0, pax: 0, bilag: [] };
      dagData[dato].omsætning += total;
      dagData[dato].pax       += pax;
      dagData[dato].bilag.push({ bilag, bogfoert: String(bogfoert), total });
    }

    return res.status(200).json({
      source,
      firmaid,
      periode: `${fromDate} → ${toDate}`,
      dage: dagData,
      _total_rapporter: rapporter.length,
      _foerste_rapport: rapporter[0]  // Til debug — vis feltnavne
    });

  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack?.slice(0, 500) });
  }
}
