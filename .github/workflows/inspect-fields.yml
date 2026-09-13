// inspect-fields.mjs — one-off diagnostic.
// Finds the four custom measurement fields on a single named batch and
// prints exactly WHERE in the JSON structure they live (the "path"), plus
// their current value — without dumping the whole batch (so recipe details
// stay private).
//
// Usage:
//   BF_USER_ID=... BF_API_KEY=... node inspect-fields.mjs "Pliny the Elder"

const FIELD_NAMES = ['Date Tapped', 'Date Kicked', 'Vol On Hand', 'Conditioning Time'];

const userId = process.env.BF_USER_ID;
const apiKey = process.env.BF_API_KEY;
const searchName = process.argv[2];

if (!userId || !apiKey) {
  console.error('Missing BF_USER_ID or BF_API_KEY environment variables.');
  process.exit(1);
}
if (!searchName) {
  console.error('Usage: node inspect-fields.mjs "Batch Name"');
  process.exit(1);
}

const auth = Buffer.from(userId + ':' + apiKey).toString('base64');

const res = await fetch('https://api.brewfather.app/v2/batches?complete=True&limit=50', {
  headers: { Authorization: 'Basic ' + auth }
});
if (!res.ok) {
  console.error('Brewfather API error:', res.status, res.statusText, await res.text());
  process.exit(1);
}
const batches = await res.json();

const match = batches.find(b => (b.name || '').toLowerCase().includes(searchName.toLowerCase()));
if (!match) {
  console.error('No batch found matching "' + searchName + '". Available names:');
  console.error(batches.map(b => '  - ' + b.name).join('\n'));
  process.exit(1);
}

console.log('Batch _id:', match._id);
console.log('Batch name:', match.name);
console.log('Batch status:', match.status);
console.log('');

// Same recursive walk as fetch-batches.mjs, but tracking the path so we can
// see exactly which key/array holds each custom field.
function findWithPath(root, targetName) {
  const target = String(targetName).trim().toLowerCase();
  let result = null;
  const seen = new Set();

  function walk(node, path) {
    if (result !== null || node === null || node === undefined) return;
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        walk(item, path.concat(`[${i}]`));
        if (result !== null) return;
      });
      return;
    }

    const label = (typeof node.name === 'string' && node.name) || (typeof node.text === 'string' && node.text) || null;
    if (label && label.trim().toLowerCase() === target) {
      if ('value' in node && node.value !== '' && node.value !== null && node.value !== undefined) {
        result = { path: path.join('.'), node };
        return;
      }
    }

    for (const key of Object.keys(node)) {
      walk(node[key], path.concat(key));
      if (result !== null) return;
    }
  }

  walk(root, []);
  return result;
}

for (const fieldName of FIELD_NAMES) {
  const found = findWithPath(match, fieldName);
  if (found) {
    console.log(`"${fieldName}" found at path: ${found.path}`);
    console.log('  node JSON:', JSON.stringify(found.node));
  } else {
    console.log(`"${fieldName}" — not found on this batch`);
  }
  console.log('');
}
