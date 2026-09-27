const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const express = require('express');
const { getPostal } = require('../dist/controllers/geo.controller');
const originalFetch = global.fetch;
after(() => { global.fetch = originalFetch; });
const app = express();
app.get('/geo/postal', getPostal);
async function request(query, responses) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    assert.ok(responses.length, 'Unexpected provider request');
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return { ok: true, json: async () => response };
  };
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await originalFetch(`http://127.0.0.1:${server.address().port}/geo/postal?${query}`);
    return { status: response.status, data: await response.json(), calls };
  } finally { await new Promise(resolve => server.close(resolve)); }
}
const place = (city, province) => ({ 'place name': city, 'state abbreviation': province });
test('HTTP endpoint falls back for a missing exact Canadian result', async () => {
  const r = await request('country=ca&postal=l4w2s7', [[], { places: [place('Mississauga (Matheson / East Rathwood)', 'ON')] }]);
  assert.equal(r.data.city, 'Mississauga');
  assert.equal(r.data.province, 'ON');
  assert.equal(r.data.approximate, true);
  assert.match(r.calls[0], /postalcode=L4W\+2S7/);
  assert.equal(r.calls[1], 'https://api.zippopotam.us/CA/L4W');
});
test('provider timeout still uses fallback', async () => {
  const r = await request('country=CA&postal=R3C4T3', [new Error('timeout'), { places: [place('Winnipeg Manitoba Provincial Government', 'MB')] }]);
  assert.equal(r.data.city, 'Winnipeg');
  assert.equal(r.data.province, 'MB');
});
test('exact result wins without fallback', async () => {
  const r = await request('country=CA&postal=M5V3A8', [[{ address: { city: 'Toronto', 'ISO3166-2-lvl4': 'CA-ON' } }]]);
  assert.equal(r.data.city, 'Toronto');
  assert.equal(r.calls.length, 1);
});
test('ambiguous FSA offers cities without choosing one', async () => {
  const r = await request('country=CA&postal=C0A0A4', [[], { places: [place('Hunter River', 'PE'), place('Montague', 'PE')] }]);
  assert.equal(r.data.city, '');
  assert.equal(r.data.province, 'PE');
  assert.deepEqual(r.data.cities, ['Hunter River', 'Montague']);
});
test('invalid and partial Canadian codes do not call providers', async () => {
  for (const postal of ['M5V', 'M5V3', 'Z9Z9Z9', '12345']) {
    const r = await request(`country=CA&postal=${postal}`, []);
    assert.deepEqual(r.data, { city: '', province: '' });
    assert.equal(r.calls.length, 0);
  }
});
test('malformed query parameters return 400', async () => {
  for (const query of ['country=CA', 'country=Canada&postal=M5V3A8', 'country=CA&postal=a&postal=b']) {
    assert.equal((await request(query, [])).status, 400);
  }
});
test('both providers failing permits manual entry', async () => {
  const r = await request('country=CA&postal=L4W2S7', [new Error('offline'), new Error('offline')]);
  assert.deepEqual(r.data, { city: '', province: '' });
});
test('US lookup retains state and never uses Canadian fallback', async () => {
  const r = await request('country=US&postal=10001', [[{ address: { city: 'New York', 'ISO3166-2-lvl4': 'US-NY' } }]]);
  assert.equal(r.data.province, 'NY');
  assert.equal(r.calls.length, 1);
});
const fs = require('node:fs');
const path = require('node:path');
test('production router uses the tested postal handler', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/index.ts'), 'utf8');
  assert.match(source, /router\.get\('\/geo\/postal', getPostal\)/);
});
test('Pakistan postal province matches the dropdown subdivision value', async () => {
  const r = await request('country=PK&postal=17200', [[{ address: {
    city: 'Chitral Tehsil', state: 'Khyber Pakhtunkhwa', 'ISO3166-2-lvl4': 'PK-KP',
  } }]]);
  assert.equal(r.data.city, 'Chitral Tehsil');
  assert.equal(r.data.province, 'KP');
  assert.equal(r.calls.length, 1);
});
test('foreign subdivision or district name cannot become a province', async () => {
  for (const address of [
    { city: 'Example', 'ISO3166-2-lvl4': 'CA-ON' },
    { city: 'Example', state_district: 'Example District' },
  ]) {
    const r = await request('country=PK&postal=17200', [[{ address }]]);
    assert.equal(r.data.province, '');
  }
});
