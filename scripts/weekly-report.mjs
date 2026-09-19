// weekly-report.mjs
// Mirrors the exact matching/calculation logic used by the OldeCellarOnTap
// website (index.html: getRecipeName, normalizeBeerName, parseBFValue,
// computeVolOnHand) so this report and the live site never disagree.
//
// For every Brewfather batch that is status "Completed" and has a
// "Date Tapped" set:
//   - if "Date Kicked" is already set in Brewfather, it's already handled -- skip.
//   - otherwise, find the anchor: the last manual "Vol On Hand" +
//     "Vol On Hand Date" recount if both are set (and the date is on/after
//     tapped date), else fall back to tapped date + kegged volume.
//   - sum ALL Public Request View rows for that beer dated after the
//     anchor through today, and subtract from the anchor volume.
//   - if the result is at or below zero, it's effectively kicked.
//
// This does NOT write anything to Brewfather or the Google Sheet -- it
// emails a summary of what to type into Brewfather by hand, since
// Brewfather's API does not support writing to custom fields.
//
// Required environment variables:
//   BF_USER_ID, BF_API_KEY       - Brewfather API credentials (existing)
//   SENDGRID_API_KEY             - API key from sendgrid.com
//   EMAIL_TO                     - comma-separated recipient(s)
//   EMAIL_CC                     - comma-separated cc recipient(s) (optional)

const REQUEST_SHEET_ID = '1bbU3rU6K7-t5n1jnE6USjTngIFBTJEoAYgKQvsdlPMk';
const REQUEST_GID = '0';
const REQUEST_CSV_URL = `https://docs.google.com/spreadsheets/d/${REQUEST_SHEET_ID}/gviz/tq?tqx=out:csv&gid=${REQUEST_GID}`;

const GROWLER_L = 1.95;
const SIXPACK_L = 6 * 0.345; // 2.07

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

// ---------- Request Log CSV parsing (ported from index.html) ----------

function parseRequestCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseRequestMDY(str) {
  if (!str) return null;

  const value = String(str).trim();

  // Require exactly 8 digits: MMDDYYYY
  if (!/^\d{8}$/.test(value)) return null;

  const m = Number(value.slice(0, 2));
  const d = Number(value.slice(2, 4));
  const y = Number(value.slice(4, 8));

  const dt = new Date(y, m - 1, d);

  // Reject invalid calendar dates and invalid months
  if (
    dt.getFullYear() !== y ||
    dt.getMonth() !== m - 1 ||
    dt.getDate() !== d
  ) {
    return null;
  }

  return dt;
}

async function fetchRequestRows() {
  const resp = await fetch(REQUEST_CSV_URL, { cache: 'no-store' });
  if (!resp.ok) throw new Error('Request Log HTTP ' + resp.status);
  const text = await resp.text();
  const table = parseRequestCSV(text);
  if (!table.length) return [];

  let startIdx = 0;
  const first = table[0];
  if (first[3] !== undefined && parseRequestMDY(first[3]) === null) startIdx = 1;

  const rows = [];
  for (let i = startIdx; i < table.length; i++) {
    const r = table[i];
    if (!r || r.length < 4) continue;
    const beer = (r[0] || '').trim();
    const growlers = parseInt(r[1], 10) || 0;
    const sixpacks = parseInt(r[2], 10) || 0;
    const dt = parseRequestMDY(r[3]);
    if (!beer || !dt) continue;
    const volume = growlers * GROWLER_L + sixpacks * SIXPACK_L;
    rows.push({ beer, growlers, sixpacks, date: dt, volume });
  }
  return rows;
}

// ---------- Brewfather fetch (full pagination, ported from index.html) ----------

async function fetchAllBatches() {
  const batches = [];
  let startAfter = null;
  const limit = 50;
  for (let page = 0; page < 60; page++) {
    let url = 'https://api.brewfather.app/v2/batches?complete=True&limit=' + limit + '&status=Completed';
    if (startAfter) url += '&start_after=' + encodeURIComponent(startAfter);
    const res = await fetch(url, { headers: bfHeaders });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Brewfather API ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
    }
    const pageData = await res.json();
    if (!Array.isArray(pageData) || pageData.length === 0) break;
    batches.push(...pageData);
    if (pageData.length < limit) break;
    startAfter = pageData[pageData.length - 1]._id;
  }
  return batches;
}

// ---------- Custom field extraction (ported from index.html) ----------

function findMeasuredNode(batch, targetName) {
  const target = String(targetName).trim().toLowerCase();
  let found = null;
  const seen = new Set();
  function walk(node) {
    if (found !== null || node === null || node === undefined) return;
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) { walk(item); if (found !== null) return; }
      return;
    }
    const label = (typeof node.name === 'string' && node.name) || (typeof node.text === 'string' && node.text) || null;
    if (label && label.trim().toLowerCase() === target) {
      if ('value' in node && node.value !== '' && node.value !== null && node.value !== undefined) {
        found = node;
        return;
      }
    }
    for (const key of Object.keys(node)) { walk(node[key]); if (found !== null) return; }
  }
  walk(batch);
  if (found === null) {
    if (targetName in batch && batch[targetName] !== null && batch[targetName] !== undefined && batch[targetName] !== '') {
      found = { value: batch[targetName] };
    }
  }
  return found;
}

function findMeasuredField(batch, targetName) {
  const node = findMeasuredNode(batch, targetName);
  return node ? node.value : null;
}

// Confirmed format: month (unpadded, 1-2 digits) + day (always 2 digits) + year (4 digits).
// e.g. 8252026 -> month 8, day 25, year 2026 -> Aug 25, 2026.
function parseCompactDigitDate(str) {
  let month, day, year;
  if (str.length === 8) {
    month = str.slice(0, 2); day = str.slice(2, 4); year = str.slice(4, 8);
  } else if (str.length === 7) {
    month = str.slice(0, 1); day = str.slice(1, 3); year = str.slice(3, 7);
  } else {
    return null;
  }
  const m = parseInt(month, 10), d = parseInt(day, 10), y = parseInt(year, 10);
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31) || y < 2000 || y > 2100) return null;
  const dt = new Date(y, m - 1, d);
  return isNaN(dt.getTime()) ? null : dt;
}

// Reverse of parseCompactDigitDate, for writing new values to report.
function toCompactDigitDate(date) {
  const m = date.getMonth() + 1;
  const d = String(date.getDate()).padStart(2, '0');
  const y = date.getFullYear();
  return `${m}${d}${y}`;
}

function parseBFValue(v) {
  if (v === null || v === undefined || v === '') return null;
  const asString = String(v).trim();
  if (/^\d{7,8}$/.test(asString)) {
    const compact = parseCompactDigitDate(asString);
    if (compact) return compact;
  }
  if (typeof v === 'number') {
    const ms = v < 10000000000 ? v * 1000 : v;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    const asNum = Number(trimmed);
    if (!isNaN(asNum) && trimmed !== '') {
      const ms = asNum < 10000000000 ? asNum * 1000 : asNum;
      const d = new Date(ms);
      if (!isNaN(d.getTime())) return d;
    }
    const d2 = new Date(trimmed);
    if (!isNaN(d2.getTime())) return d2;
  }
  return null;
}

function getRecipeName(batch) {
  if (batch.recipe && typeof batch.recipe.name === 'string' && batch.recipe.name.trim()) {
    return batch.recipe.name;
  }
  return batch.name;
}

function normalizeBeerName(name) {
  return (name || 'Unnamed Beer').trim().replace(/\s+/g, ' ');
}

function toReadableDate(date) {
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' });
}

// ---------- Vol On Hand calculation (ported from index.html computeVolOnHand) ----------

function computeVolOnHand(batches, requestRows) {
  const results = [];
  const now = new Date();

  for (const b of batches) {
    const tappedDate = parseBFValue(findMeasuredField(b, 'Date Tapped'));
    if (!tappedDate) continue; // never tapped -- nothing to project

    const kickedDate = parseBFValue(findMeasuredField(b, 'Date Kicked'));
    const name = normalizeBeerName(getRecipeName(b));
    const volKegged = (typeof b.measuredBottlingSize === 'number') ? b.measuredBottlingSize : null;
    const batchNumber = b.batchNo || b.batchNumber || null;

    if (kickedDate) {
      // Already recorded as kicked in Brewfather -- nothing to report.
      continue;
    }

    const manualVolRaw = findMeasuredField(b, 'Vol On Hand');
    const manualVol = (typeof manualVolRaw === 'number') ? manualVolRaw : (manualVolRaw ? Number(manualVolRaw) : null);
    const manualDate = parseBFValue(findMeasuredField(b, 'Vol On Hand Date'));

    let anchorDate = tappedDate;
    let anchorVolume = volKegged;
    let anchorIsManual = false;
    if (manualDate && manualVol !== null && !isNaN(manualVol) && manualDate >= tappedDate) {
      anchorDate = manualDate;
      anchorVolume = manualVol;
      anchorIsManual = true;
    }

    const matchesSinceAnchor = requestRows.filter(r =>
      normalizeBeerName(r.beer).toLowerCase() === name.toLowerCase() &&
      r.date > anchorDate && r.date <= now
    );
    const drawnDownSinceAnchor = matchesSinceAnchor.reduce((sum, r) => sum + r.volume, 0);
    const remaining = (anchorVolume !== null) ? Math.round((anchorVolume - drawnDownSinceAnchor) * 100) / 100 : null;

    // Also compute just the last 7 days, for context in the email.
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const matchesThisWeek = requestRows.filter(r =>
      normalizeBeerName(r.beer).toLowerCase() === name.toLowerCase() &&
      r.date > sevenDaysAgo && r.date <= now
    );
    const litersThisWeek = Math.round(matchesThisWeek.reduce((sum, r) => sum + r.volume, 0) * 100) / 100;

    results.push({
      name,
      batchNumber,
      tappedDate,
      anchorDate,
      anchorVolume,
      anchorIsManual,
      drawnDownSinceAnchor: Math.round(drawnDownSinceAnchor * 100) / 100,
      remaining,
      litersThisWeek,
      kicked: remaining !== null && remaining <= 0,
      hasVolData: anchorVolume !== null
    });
  }

  return results;
}

// ---------- Main ----------

async function main() {
  const [batches, requestRows] = await Promise.all([fetchAllBatches(), fetchRequestRows()]);
  const results = computeVolOnHand(batches, requestRows);

  const today = new Date();
  const todayCompact = toCompactDigitDate(today);
  const subject = `Olde Cellar - Weekly Vol On Hand Update (${toReadableDate(today)})`;

  let html = `<h2 style="font-family: sans-serif;">Weekly Vol On Hand Update</h2>`;
  html += `<p style="font-family: sans-serif;">As of: ${toReadableDate(today)}. Figures below are the LIVE running balance since each beer's last recount or tap date -- not just this week's activity.</p>`;

  if (results.length === 0) {
    html += `<p style="font-family: sans-serif;">No currently-tapped, un-kicked batches found in Brewfather.</p>`;
  } else {
    results.sort((a, b) => (a.remaining ?? Infinity) - (b.remaining ?? Infinity));
    for (const r of results) {
      html += `<div style="font-family: sans-serif; border: 1px solid #ccc; border-radius: 8px; padding: 16px; margin-bottom: 16px;">`;
      html += `<h3 style="margin: 0 0 8px 0;">${r.name}${r.batchNumber ? ` (batch #${r.batchNumber})` : ''}</h3>`;
      if (!r.hasVolData) {
        html += `<p style="margin: 4px 0; color: #b45309;">No kegged/on-hand volume data available for this batch -- update manually.</p>`;
      } else {
        html += `<p style="margin: 4px 0;">Anchor: ${r.anchorIsManual ? 'last manual recount' : 'kegged volume at tap date'} on ${toReadableDate(r.anchorDate)} = <strong>${r.anchorVolume}L</strong></p>`;
        html += `<p style="margin: 4px 0;">Drawn down since anchor: <strong>${r.drawnDownSinceAnchor}L</strong> (of which ${r.litersThisWeek}L in the past 7 days)</p>`;
        html += `<p style="margin: 4px 0;">Current Vol On Hand: <strong>${Math.max(r.remaining, 0)}L</strong></p>`;
        if (r.kicked) {
          html += `<p style="margin: 8px 0; color: #b91c1c; font-weight: bold;">This beer is KICKED. In Brewfather: set Vol On Hand = 0, Vol On Hand Date = ${todayCompact}, Date Kicked = ${todayCompact}, and change Status to Archived.</p>`;
        } else {
          html += `<p style="margin: 4px 0;">To record a fresh recount today, set Vol On Hand = ${Math.max(r.remaining, 0)}, Vol On Hand Date = <strong>${todayCompact}</strong>.</p>`;
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
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error('weekly-report.mjs failed:', err);
  process.exit(1);
});
