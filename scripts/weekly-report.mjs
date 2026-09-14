// weekly-report.mjs
// Reads the "Olde Cellar-Public Request View" Google Sheet, sums up the
// last 7 days of growlers/6-packs per beer, checks each beer's CURRENT
// "Vol On Hand" in Brewfather (read-only -- writing to custom fields is
// not supported by Brewfather's API), calculates what the new value
// and date should be, and emails a summary report so it can be typed
// into Brewfather by hand.
//
// Does NOT write anything to Brewfather or to the Google Sheet.
//
// Email is sent via the SendGrid API (https://sendgrid.com) using a
// verified "Single Sender" -- this lets the email come from
// oldecellarbrewing@gmail.com and go to any recipient, with no domain
// purchase and no 2-Step Verification needed anywhere.
//
// Required environment variables:
//   BF_USER_ID, BF_API_KEY       - Brewfather API credentials (existing)
//   SENDGRID_API_KEY             - API key from sendgrid.com
//   EMAIL_TO                     - comma-separated recipient(s)
//   EMAIL_CC                     - comma-separated cc recipient(s) (optional)

const SHEET_ID = '1bbU3rU6K7-t5n1jnE6USjTngIFBTJEoAYgKQvsdlPMk';
const SHEET_GID = '0';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;

const BOTTLE_LITERS = 0.345;
const GROWLER_LITERS = 1.95;
const SIXPACK_LITERS = 6 * BOTTLE_LITERS; // 2.07L

const {
  BF_USER_ID,
  BF_API_KEY,
  SENDGRID_API_KEY,
  EMAIL_TO,
  EMAIL_CC
} = process.env;

for (const [name, val] of Object.entries({ BF_USER_ID, BF_API_KEY, SENDGRID_API_KEY, EMAIL_TO })) {
  if (!val) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const bfAuth = Buffer.from(`${BF_USER_ID}:${BF_API_KEY}`).toString('base64');
const bfHeaders = { Authorization: 'Basic ' + bfAuth };

// --- Tiny CSV parser (handles simple quoted fields, good enough for this sheet) ---
function parseCsv(text) {
  return text
    .split(/\r?\n/)
    .filter(line => line.length > 0)
    .map(line => {
      const cells = [];
      let cur = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          inQuotes = !inQuotes;
        } else if (c === ',' && !inQuotes) {
          cells.push(cur);
          cur = '';
        } else {
          cur += c;
        }
      }
      cells.push(cur);
      return cells;
    });
}

// --- Brewfather date format: day (unpadded, 1-2 digits) + month (always 2-digit) + year (4-digit) ---
// Confirmed against real data: rightmost 4 digits = year, next 2 = month
// (always zero-padded), leftmost 1-2 remaining digits = day (no leading
// zero, since Brewfather strips leading zeros on the whole number).
// Example: 20122024 -> year 2024, month 12, day 20 -> Dec 20, 2024.
function toBrewfatherDate(date) {
  const d = date.getDate();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}${m}${y}`;
}

function toReadableDate(date) {
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' });
}

async function main() {
  // 1. Fetch and parse the public sheet
  const csvRes = await fetch(CSV_URL);
  if (!csvRes.ok) {
    throw new Error(`Failed to fetch sheet CSV: ${csvRes.status} ${csvRes.statusText}`);
  }
  const csvText = await csvRes.text();
  const rows = parseCsv(csvText);
  const dataRows = rows.slice(1); // skip header row

  // 2. Determine the trailing 7-day report window
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayMidnight);
  weekStart.setDate(weekStart.getDate() - 6);

  // 3. Aggregate growlers/6-packs per beer within the window
  const beerTotals = new Map(); // name -> { growlers, sixPacks, latestDate }

  for (const row of dataRows) {
    const [beerName, growlersRaw, sixPacksRaw, dateRaw] = row;
    if (!beerName || !dateRaw) continue;

    const rowDate = new Date(dateRaw);
    if (isNaN(rowDate.getTime())) continue;
    const rowDateOnly = new Date(rowDate.getFullYear(), rowDate.getMonth(), rowDate.getDate());
    if (rowDateOnly < weekStart || rowDateOnly > todayMidnight) continue;

    const growlers = Number(growlersRaw) || 0;
    const sixPacks = Number(sixPacksRaw) || 0;
    if (growlers === 0 && sixPacks === 0) continue;

    const key = beerName.trim();
    if (!beerTotals.has(key)) {
      beerTotals.set(key, { growlers: 0, sixPacks: 0, latestDate: rowDateOnly });
    }
    const entry = beerTotals.get(key);
    entry.growlers += growlers;
    entry.sixPacks += sixPacks;
    if (rowDateOnly > entry.latestDate) entry.latestDate = rowDateOnly;
  }

  if (beerTotals.size === 0) {
    console.log('No activity found in the past 7 days -- nothing to report.');
  }

  // 4. Fetch Brewfather batch list once
  const listRes = await fetch('https://api.brewfather.app/v2/batches?complete=True&limit=50', { headers: bfHeaders });
  if (!listRes.ok) {
    throw new Error(`Brewfather batch list failed: ${listRes.status} ${listRes.statusText}`);
  }
  const batches = await listRes.json();
  const activeBatches = batches.filter(b => (b.status || '').toLowerCase() === 'completed');

  // 5. Build the report
  const reportLines = [];

  for (const [beerName, { growlers, sixPacks, latestDate }] of beerTotals.entries()) {
    const liters = Math.round((growlers * GROWLER_LITERS + sixPacks * SIXPACK_LITERS) * 100) / 100;

    const match = activeBatches.find(b => (b.name || '').toLowerCase().includes(beerName.toLowerCase()));
    if (!match) {
      reportLines.push({
        beerName,
        growlers,
        sixPacks,
        liters,
        note: 'No matching active ("Completed") batch found in Brewfather -- update manually.'
      });
      continue;
    }

    const fullRes = await fetch(`https://api.brewfather.app/v2/batches/${match._id}`, { headers: bfHeaders });
    if (!fullRes.ok) {
      reportLines.push({
        beerName,
        growlers,
        sixPacks,
        liters,
        note: `Could not fetch batch details from Brewfather (${fullRes.status}).`
      });
      continue;
    }
    const full = await fullRes.json();
    const measurements = Array.isArray(full.measurements) ? full.measurements : [];
    const volField = measurements.find(m => (m.text || '').trim().toLowerCase() === 'vol on hand');

    if (!volField) {
      reportLines.push({
        beerName,
        batchName: match.name,
        growlers,
        sixPacks,
        liters,
        note: 'No "Vol On Hand" field found on this batch -- update manually.'
      });
      continue;
    }

    const currentVol = Number(volField.value) || 0;
    const newVolRaw = currentVol - liters;
    const kicked = newVolRaw <= 0;
    const newVol = kicked ? 0 : Math.round(newVolRaw * 100) / 100;
    const dateStamp = toBrewfatherDate(latestDate);

    reportLines.push({
      beerName,
      batchName: match.name,
      growlers,
      sixPacks,
      liters,
      currentVol,
      newVol,
      dateStamp,
      dateReadable: toReadableDate(latestDate),
      kicked
    });
  }

  // 6. Compose and send the email
  const subject = `Olde Cellar - Weekly Vol On Hand Update (${toReadableDate(todayMidnight)})`;

  let html = `<h2 style="font-family: sans-serif;">Weekly Vol On Hand Update</h2>`;
  html += `<p style="font-family: sans-serif;">Report window: ${toReadableDate(weekStart)} - ${toReadableDate(todayMidnight)}</p>`;

  if (reportLines.length === 0) {
    html += `<p style="font-family: sans-serif;">No requests were fulfilled in this window.</p>`;
  } else {
    for (const line of reportLines) {
      html += `<div style="font-family: sans-serif; border: 1px solid #ccc; border-radius: 8px; padding: 16px; margin-bottom: 16px;">`;
      html += `<h3 style="margin: 0 0 8px 0;">${line.beerName}${line.batchName ? ` (${line.batchName})` : ''}</h3>`;
      html += `<p style="margin: 4px 0;">This week: ${line.growlers} growler(s), ${line.sixPacks} six-pack(s) = <strong>${line.liters}L</strong></p>`;
      if (line.note) {
        html += `<p style="margin: 4px 0; color: #b45309;">${line.note}</p>`;
      } else {
        html += `<p style="margin: 4px 0;">Current Vol On Hand: <strong>${line.currentVol}L</strong> &rarr; New Vol On Hand: <strong>${line.newVol}L</strong></p>`;
        html += `<p style="margin: 4px 0;">Vol On Hand Date to enter: <strong>${line.dateStamp}</strong> (${line.dateReadable})</p>`;
        if (line.kicked) {
          html += `<p style="margin: 8px 0; color: #b91c1c; font-weight: bold;">This beer is KICKED. In Brewfather: set Vol On Hand = 0, Vol On Hand Date = ${line.dateStamp}, Date Kicked = ${line.dateStamp}, and change Status to Archived.</p>`;
        }
      }
      html += `</div>`;
    }
  }

  const toList = EMAIL_TO.split(',').map(s => s.trim()).filter(Boolean).map(email => ({ email }));
  const ccList = EMAIL_CC ? EMAIL_CC.split(',').map(s => s.trim()).filter(Boolean).map(email => ({ email })) : undefined;

  const personalization = { to: toList };
  if (ccList && ccList.length > 0) personalization.cc = ccList;

  const emailPayload = {
    personalizations: [personalization],
    from: { email: 'jeffherr@ccimail.com', name: 'Olde Cellar Brewing' },
    subject,
    content: [{ type: 'text/html', value: html }]
  };

  const sendRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(emailPayload)
  });

  if (!sendRes.ok) {
    const errBody = await sendRes.text();
    throw new Error(`SendGrid email failed: ${sendRes.status} ${sendRes.statusText} - ${errBody}`);
  }

  console.log('Report emailed successfully.');
  console.log('---');
  console.log(JSON.stringify(reportLines, null, 2));
}

main().catch(err => {
  console.error('weekly-report.mjs failed:', err);
  process.exit(1);
});
