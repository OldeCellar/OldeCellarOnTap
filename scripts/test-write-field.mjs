// test-write-field.mjs
// Attempts to update ONE custom measurement field on ONE batch, then
// re-reads the batch back from Brewfather to confirm whether the write
// actually stuck. This is the real test of whether Brewfather's API
// supports writing to custom fields (their docs don't say either way).
//
// SAFE BY DEFAULT: if you don't pass a newValue, it writes the field's
// CURRENT value back unchanged (only the timestamp updates) -- so you can
// test the mechanism without risking your real data.
//
// Usage:
//   node scripts/test-write-field.mjs "<batch name>" "<field text>" [newValue]
//
// Examples:
//   node scripts/test-write-field.mjs "MaiBock" "Vol On Hand"        (identity test)
//   node scripts/test-write-field.mjs "MaiBock" "Vol On Hand" 35     (explicit, same value)

const userId = process.env.BF_USER_ID;
const apiKey = process.env.BF_API_KEY;
const [batchNameArg, fieldNameArg, newValueArg] = process.argv.slice(2);

if (!userId || !apiKey || !batchNameArg || !fieldNameArg) {
  console.error('Usage: node test-write-field.mjs "<batch name>" "<field text>" [newValue]');
  process.exit(1);
}

const auth = Buffer.from(userId + ':' + apiKey).toString('base64');
const headers = { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' };

// 1. Find the batch id by name
const listRes = await fetch('https://api.brewfather.app/v2/batches?complete=True&limit=50', { headers });
if (!listRes.ok) {
  console.error('List batches failed:', listRes.status, await listRes.text());
  process.exit(1);
}
const batches = await listRes.json();
const match = batches.find(b => (b.name || '').toLowerCase().includes(batchNameArg.toLowerCase()));
if (!match) {
  console.error('No batch found matching "' + batchNameArg + '". Available:');
  console.error(batches.map(b => '  - ' + b.name).join('\n'));
  process.exit(1);
}

// 2. Fetch the full batch (to get the complete measurements array)
const fullRes = await fetch(`https://api.brewfather.app/v2/batches/${match._id}`, { headers });
if (!fullRes.ok) {
  console.error('Fetch batch failed:', fullRes.status, await fullRes.text());
  process.exit(1);
}
const full = await fullRes.json();

if (!Array.isArray(full.measurements)) {
  console.error('This batch has no "measurements" array at the top level -- structure may differ from what we expect.');
  process.exit(1);
}

const idx = full.measurements.findIndex(
  m => (m.text || '').trim().toLowerCase() === fieldNameArg.trim().toLowerCase()
);
if (idx === -1) {
  console.error(`Field "${fieldNameArg}" not found on batch "${match.name}". Existing fields:`);
  console.error(full.measurements.map(m => '  - ' + m.text + ' = ' + m.value).join('\n'));
  process.exit(1);
}

const before = { ...full.measurements[idx] };
const isIdentityTest = newValueArg === undefined || newValueArg === '';
const newValue = isIdentityTest ? before.value : Number(newValueArg);

// Rebuild the FULL array, changing only the target entry -- sending the
// whole array back (not just the one field) protects the other custom
// fields in case Brewfather replaces the array wholesale on PATCH.
const updatedMeasurements = full.measurements.map((m, i) =>
  i === idx ? { ...m, value: newValue, timestamp: Date.now() } : m
);

console.log(`Batch: ${match.name} (${match._id})`);
console.log(`Field: "${fieldNameArg}"`);
console.log(`Current value: ${before.value}`);
console.log(`Attempting to write: ${newValue}${isIdentityTest ? ' (identity test - same value, timestamp only)' : ''}`);
console.log('');

// 3. PATCH the batch
const patchRes = await fetch(`https://api.brewfather.app/v2/batches/${match._id}`, {
  method: 'PATCH',
  headers,
  body: JSON.stringify({ measurements: updatedMeasurements })
});
const patchBody = await patchRes.text();
console.log('PATCH response status:', patchRes.status, patchRes.statusText);
console.log('PATCH response body:', patchBody);
console.log('');

// 4. Re-fetch to see if it actually stuck
const verifyRes = await fetch(`https://api.brewfather.app/v2/batches/${match._id}`, { headers });
const verify = await verifyRes.json();
const verifyField = (verify.measurements || []).find(
  m => (m.text || '').trim().toLowerCase() === fieldNameArg.trim().toLowerCase()
);

console.log('Re-read after write:', verifyField ? JSON.stringify(verifyField) : '(field not found on re-read)');
console.log('');
if (verifyField && Number(verifyField.value) === newValue) {
  console.log('RESULT: SUCCESS - the write persisted.');
} else {
  console.log('RESULT: DID NOT PERSIST - the value did not change as expected. Writing to custom fields is likely not supported via this API call shape.');
}
