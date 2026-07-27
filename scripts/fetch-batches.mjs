// Fetches Brewfather batches using server-side secrets (never exposed to the
// browser) and writes a filtered snapshot to data/batches.json.
//
// Only the fields the on-tap app actually displays are kept — full recipe
// details (ingredients, mash schedule, water profile, etc.) are stripped out
// so recipes stay private even though this file is published publicly.
//
// If you rename any of the four custom measurement fields in Brewfather,
// update FIELD_NAMES below to match.

import { writeFileSync, mkdirSync } from 'fs';

const FIELD_NAMES = ['Date Tapped', 'Date Kicked', 'Vol On Hand', 'Conditioning Time'];

const userId = process.env.BF_USER_ID;
const apiKey = process.env.BF_API_KEY;

if (!userId || !apiKey) {
  console.error('Missing BF_USER_ID or BF_API_KEY environment variables (set as repo secrets).');
  process.exit(1);
}

const auth = Buffer.from(userId + ':' + apiKey).toString('base64');

async function fetchAllBatches() {
  const batches = [];
  let startAfter = null;
  const limit = 50;
  for (let page = 0; page < 60; page++) {
    let url = 'https://api.brewfather.app/v2/batches?complete=True&limit=' + limit;
    if (startAfter) url += '&start_after=' + encodeURIComponent(startAfter);
    const res = await fetch(url, { headers: { Authorization: 'Basic ' + auth } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('Brewfather API ' + res.status + ' ' + res.statusText + ' ' + body.slice(0, 300));
    }
    const pageData = await res.json();
    if (!Array.isArray(pageData) || pageData.length === 0) break;
    batches.push(...pageData);
    if (pageData.length < limit) break;
    startAfter = pageData[pageData.length - 1]._id;
  }
  return batches;
}

// Same generic recursive scan the client uses: finds a {name|text, value} pair
// anywhere in the batch object matching a target field label.
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
      for (const item of node) {
        walk(item);
        if (found !== null) return;
      }
      return;
    }
    const label = (typeof node.name === 'string' && node.name) || (typeof node.text === 'string' && node.text) || null;
    if (label && label.trim().toLowerCase() === target) {
      if ('value' in node && node.value !== '' && node.value !== null && node.value !== undefined) {
        found = node;
        return;
      }
    }
    for (const key of Object.keys(node)) {
      walk(node[key]);
      if (found !== null) return;
    }
  }
  walk(batch);
  if (found === null && targetName in batch && batch[targetName] !== null && batch[targetName] !== undefined && batch[targetName] !== '') {
    found = { value: batch[targetName] };
  }
  return found;
}

function getFermentationScheduleDays(batch) {
  if (batch.recipe && batch.recipe.fermentation && Array.isArray(batch.recipe.fermentation.steps)) {
    const total = batch.recipe.fermentation.steps.reduce((sum, step) => sum + (typeof step.stepTime === 'number' ? step.stepTime : 0), 0);
    return total > 0 ? total : null;
  }
  return null;
}

function toMinimalBatch(b) {
  const measurements = [];
  for (const fieldName of FIELD_NAMES) {
    const node = findMeasuredNode(b, fieldName);
    if (node && node.value !== null && node.value !== undefined && node.value !== '') {
      measurements.push({ text: fieldName, value: node.value });
    }
  }
  const fermDays = getFermentationScheduleDays(b);
  const recipeName = (b.recipe && typeof b.recipe.name === 'string' && b.recipe.name.trim()) ? b.recipe.name : b.name;

  return {
    _id: b._id,
    status: b.status,
    name: b.name,
    batchNo: b.batchNo || b.batchNumber || null,
    brewDate: b.brewDate || null,
    bottlingDate: b.bottlingDate || null,
    measuredBottlingSize: (typeof b.measuredBottlingSize === 'number') ? b.measuredBottlingSize : null,
    measurements,
    recipe: {
      name: recipeName,
      fermentation: fermDays !== null ? { steps: [{ stepTime: fermDays }] } : undefined
    }
  };
}

const rawBatches = await fetchAllBatches();
const minimalBatches = rawBatches.map(toMinimalBatch);

const out = {
  generatedAt: new Date().toISOString(),
  batches: minimalBatches
};

mkdirSync('data', { recursive: true });
writeFileSync('data/batches.json', JSON.stringify(out));
console.log('Wrote', minimalBatches.length, 'batches to data/batches.json');
