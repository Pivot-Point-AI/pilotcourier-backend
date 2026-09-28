const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { lookupPostal } = require('../dist/services/postal.service');
const { fixtures } = require('./fixtures/postal-70-country.json');
const originalFetch = global.fetch;
after(() => { global.fetch = originalFetch; });
for (const fixture of fixtures) {
  test(`postal audit replay ${fixture.country} ${fixture.postal}`, async () => {
    const requested = [];
    global.fetch = async url => {
      requested.push(String(url));
      const provider = fixture.providers.find(p => p.url === String(url));
      assert.ok(provider, `Unexpected provider request: ${url}`);
      return { ok: provider.status === 200, json: async () => provider.data };
    };
    const result = await lookupPostal(fixture.country, fixture.postal);
    assert.deepEqual(result, fixture.expected);
    assert.deepEqual(requested, fixture.providers.map(p => p.url));
  });
}
test('subdivision fallback preserves level 4 and ignores unknown or foreign levels', async () => {
  for (const [country, address, expected] of [
    ['IE', { 'ISO3166-2-lvl4': 'IE-D', 'ISO3166-2-lvl6': 'IE-CO' }, 'D'],
    ['IE', { 'ISO3166-2-lvl6': 'US-NY', 'ISO3166-2-lvl5': 'IE-L' }, ''],
    ['IS', { 'ISO3166-2-lvl6': 'IS-BOG' }, ''],
    ['EE', { 'ISO3166-2-lvl7': 'EE-784' }, ''],
    ['US', { 'ISO3166-2-lvl6': 'US-NY' }, ''],
    ['PK', { 'ISO3166-2-lvl6': 'PK-KP' }, ''],
    ['PH', { 'ISO3166-2-lvl3': 'PH-03' }, ''],
    ['PT', { 'ISO3166-2-lvl6': 'PT-' }, ''],
  ]) {
    global.fetch = async () => ({ ok: true, json: async () => [{ address: { city: 'Fixture', ...address } }] });
    assert.equal((await lookupPostal(country, fixtures.find(f => f.country === country).postal)).province, expected);
  }
});
