// ================================================================
// api/weekly-report.js — Omar Gruppen automatisk ugentlig rapport
//
// Kører hver mandag kl. 07:00 via Vercel Cron.
// 1. Henter salgsdata for alle fire restauranter fra OnlinePOS
// 2. Analyserer tallene med Claude API
// 3. Sender rapporten på email via Resend
//
// Miljøvariabler der skal sættes i Vercel:
//   ANTHROPIC_API_KEY  — Claude API nøgle
//   RESEND_API_KEY     — Resend API nøgle
//   REPORT_EMAIL       — Modtager(e), kommasepareret
// ================================================================

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const RESTAURANTS = [
  { name: 'OMAR',   firmaid: 13438, token: 'e97ee86e7d88c54c1ca3d0b5b5eed3c95a4eda0d05a448958ebde5e80d9c6ba9', lukket: [] },
  { name: 'Safari', firmaid: 12510, token: '628633d366d5a569c91116ed0ae281db5402755f298d8ebf07691c19107ce587', lukket: [0] },
  { name: 'Lamar',  firmaid: 15123, token: 'f6b5780221629ae89c5e47873cfbbc93dda6da2873a7aed283da3c01ae558ac3', lukket: [0] },
  { name: 'Kima',   firmaid: 18089, token: '1504ee0a3000257fe676b37c66edf37feb2a3a592829c84a31f7e428b1073b17', lukket: [] },
];

const DAGE = ['Søndag', 'Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag'];

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

function toISO(dateStr) {
  const m = dateStr.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

async function hentRestaurant(rest, fromDate, toDate) {
  const fromUnix = toUnixDK(fromDate, false) - (6 * 3600);
  const toUnix   = toUnixDK(toDate, true);
  try {
    const response = await fetch('https://api.onlinepos.dk/api/exportSales', {
      method: 'POST',
      headers: {
        'token': String(rest.token),
        'firmaid': String(rest.firmaid),
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `from=${fromUnix}&to=${toUnix}`
    });
    const data = await response.json();
    if (!data.sales) return {};
    const daglig = {};
    for (const item of data.sales) {
      const l = item.line || item;
      const dato = korrektDato(l.date || '', l.time || '');
      const iso  = toISO(dato);
      if (!iso || iso < fromDate || iso > toDate) continue;
      if (!daglig[iso]) daglig[iso] = { omsaetning: 0, transaktioner: 0 };
      daglig[iso].omsaetning    += parseFloat((l.price || '0').toString().replace(',', '.')) || 0;
      daglig[iso].transaktioner += 1;
    }
    return daglig;
  } catch(e) {
    return {};
  }
}

function getUgePeriode() {
  const idag = new Date();
  // Gå tilbage til forrige mandag
  const dagINummer = idag.getDay() || 7; // 1=man, 7=søn
  const mandagOffset = dagINummer - 1 + 7; // altid forrige uge
  const mandag = new Date(idag);
  mandag.setDate(idag.getDate() - mandagOffset);
  const soendag = new Date(mandag);
  soendag.setDate(mandag.getDate() + 6);
  const fmt = d => d.toISOString().split('T')[0];
  return { fromDate: fmt(mandag), toDate: fmt(soendag) };
}

export default async function handler(req, res) {
  // Tillad manuel kørsel via GET samt Vercel Cron
  const erCron = req.headers['x-vercel-cron'] === '1';
  const erManuel = req.method === 'GET' && req.query.run === 'now';
  if (!erCron && !erManuel) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { fromDate, toDate } = getUgePeriode();

  // Hent data for alle restauranter parallelt
  const resultater = await Promise.all(
    RESTAURANTS.map(r => hentRestaurant(r, fromDate, toDate))
  );

  // Byg datasummary til Claude
  const datoer = [];
  const d = new Date(fromDate);
  while (d <= new Date(toDate)) {
    datoer.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 1);
  }

  let datasummary = `Salgsdata for Omar Gruppen — uge ${fromDate} til ${toDate}\n\n`;
  let totaler = {};
  RESTAURANTS.forEach(r => totaler[r.name] = 0);

  for (const dato of datoer) {
    const dagNavn = DAGE[new Date(dato).getDay()];
    datasummary += `${dato} (${dagNavn}):\n`;
    RESTAURANTS.forEach((r, i) => {
      const d = resultater[i][dato] || { omsaetning: 0, transaktioner: 0 };
      const lukket = r.lukket.includes(new Date(dato).getDay());
      datasummary += `  ${r.name}: ${lukket ? 'Lukket' : Math.round(d.omsaetning) + ' kr (' + d.transaktioner + ' transaktioner)'}\n`;
      totaler[r.name] += d.omsaetning;
    });
  }

  datasummary += `\nUGENS TOTALER:\n`;
  let grandTotal = 0;
  RESTAURANTS.forEach(r => {
    datasummary += `  ${r.name}: ${Math.round(totaler[r.name])} kr\n`;
    grandTotal += totaler[r.name];
  });
  datasummary += `  TOTAL: ${Math.round(grandTotal)} kr\n`;

  // Generer rapport med Claude API
  const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `Du er driftsassistent for Omar Gruppen. Lav en kort ugentlig salgsrapport på dansk baseret på disse data. Vær direkte og konkret. Fremhæv hvad der kræver opmærksomhed.

Rapporten skal indeholde:
1. Ugens samlede omsætning per restaurant og totalt
2. Hvilken restaurant klarede sig bedst
3. Afvigelser eller mønstre der kræver opmærksomhed
4. En samlet vurdering i 3-5 sætninger

${datasummary}`
      }]
    })
  });

  const claudeData = await claudeResponse.json();
  const rapport = claudeData.content?.[0]?.text || 'Kunne ikke generere rapport.';

  // Send email via Resend
  const modtagere = (process.env.REPORT_EMAIL || 'simon@restaurantomar.dk').split(',').map(e => e.trim());

  const emailResponse = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Omar Gruppen Dashboard <rapport@restaurantomar.dk>',
      to: modtagere,
      subject: `Ugentlig salgsrapport — uge ${fromDate} til ${toDate}`,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1a1a2e; border-bottom: 2px solid #7F77DD; padding-bottom: 10px;">
            Omar Gruppen — Ugentlig rapport
          </h2>
          <p style="color: #666; font-size: 14px;">${fromDate} → ${toDate}</p>
          
          <div style="background: #f8f8f8; border-radius: 8px; padding: 16px; margin: 20px 0;">
            ${rapport.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}
          </div>

          <h3 style="color: #1a1a2e;">Omsætning denne uge</h3>
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <tr style="background: #7F77DD; color: white;">
              <th style="padding: 8px 12px; text-align: left;">Restaurant</th>
              <th style="padding: 8px 12px; text-align: right;">Omsætning</th>
            </tr>
            ${RESTAURANTS.map((r, i) => `
              <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 8px 12px;">${r.name}</td>
                <td style="padding: 8px 12px; text-align: right; font-weight: 600;">
                  ${Math.round(totaler[r.name]).toLocaleString('da-DK')} kr
                </td>
              </tr>
            `).join('')}
            <tr style="background: #f0f0f0; font-weight: 700;">
              <td style="padding: 8px 12px;">TOTAL</td>
              <td style="padding: 8px 12px; text-align: right;">
                ${Math.round(grandTotal).toLocaleString('da-DK')} kr
              </td>
            </tr>
          </table>

          <p style="color: #999; font-size: 12px; margin-top: 30px;">
            Sendt automatisk af Omar Gruppen Dashboard · ${new Date().toLocaleDateString('da-DK')}
          </p>
        </div>
      `
    })
  });

  const emailData = await emailResponse.json();

  return res.status(200).json({
    success: true,
    periode: { fromDate, toDate },
    totaler,
    grandTotal: Math.round(grandTotal),
    emailSendt: emailData.id ? true : false,
    emailId: emailData.id
  });
}
