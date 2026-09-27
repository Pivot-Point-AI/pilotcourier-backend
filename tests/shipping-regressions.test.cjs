const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
process.env.VERCEL = '1';
process.env.RATE_MARKUP_PERCENT = '0';
require('../dist/utils/logger').default.silent = true;
const service = require('../dist/services/netparcel.service').default;
const Shipment = require('../dist/models/Shipment').default;
const controller = require('../dist/controllers/shipment.controller');
const { normalizeDeliveryDate } = require('../dist/utils/rate-display');
const frontendPath = path.resolve(__dirname, '../../frontend/src/lib/rate-display.ts');
const frontendCode = ts.transpileModule(fs.readFileSync(frontendPath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const frontend = { exports: {} };
vm.runInNewContext(frontendCode, frontend);
async function invoke(fn, body) {
  let status = 200, data;
  await fn({ body }, { status(value) { status = value; return this; }, json(value) { data = value; return this; } }, error => { throw error; });
  return { status, data };
}
const parcel = { weight: 5, weightUnit: 'lbs', length: 10, width: 8, height: 6, dimensionUnit: 'in', description: 'Regression fixture', insuranceAmount: 125, specialHandling: true, freightClass: '77.5', quantity: 1 };
const address = { name: 'Test', street: 'Test Street', city: 'Toronto', province: 'ON', postalCode: 'M5V3A8', country: 'CA', phone: '4165550100' };
const rawRates = [
  { service_code: 'same', service_name: 'FedEx Ground', total_price: '37.35', currency: 'USD', transit_days: 3, max_delivery_date: '2026-09-30T00:00:00+05:00' },
  { service_code: 'same', service_name: 'ICS Ground', total_price: '42.58', currency: 'CAD', transit_days: 4, max_delivery_date: '30 September 2026' },
  { service_code: 'other', service_name: 'UPS Express', total_price: '60.00', currency: 'CAD', transit_days: 1, max_delivery_date: '2026-09-28' },
];
function assertCurrencyBadges(rates) {
  assert.equal(rates.filter(rate => rate.isCheapest && rate.currency === 'CAD').length, 1);
  assert.equal(rates.filter(rate => rate.isCheapest && rate.currency === 'USD').length, 1);
  assert.equal(rates.find(rate => rate.totalCharge === 60).isCheapest, false);
  assert.equal(rates.find(rate => rate.totalCharge === 60).isFastest, true);
}
test('quote response groups currencies, computes badges and preserves calendar days', async () => {
  service.getRates = async () => rawRates;
  const result = await invoke(controller.getRates, { originPostal: 'M5V3A8', destinationPostal: 'V6B1A1', packages: [parcel] });
  assert.equal(result.status, 200);
  assertCurrencyBadges(result.data.rates);
  assert.deepEqual(result.data.rates.map(rate => rate.currency), ['CAD', 'CAD', 'USD']);
  assert.equal(result.data.rates.find(rate => rate.currency === 'USD').estimatedDelivery, '2026-09-30');
  assert.equal(result.data.rates.find(rate => rate.totalCharge === 42.58).estimatedDelivery, '2026-09-30');
  // An older saved response may carry incorrect flags and ordering.
  const stale = result.data.rates.slice().reverse().map(rate => ({ ...rate, isCheapest: rate.currency === 'USD' }));
  assertCurrencyBadges(frontend.exports.prepareRates(stale));
  assert.equal(frontend.exports.prepareRates([]).length, 0);
});
test('booking persists package fields and all three references through final carrier payload', async () => {
  let quotePayload, shipPayload, persisted;
  service.getRates = async payload => { quotePayload = payload; return rawRates; };
  const quote = await invoke(controller.getRates, { originPostal: 'M5V3A8', destinationPostal: 'V6B1A1', packagingType: 'Pallet', packages: [parcel] });
  const references = [1, 2, 3].map(n => ({ referenceName: `Reference ${n}`, referenceValue: `Value ${n}` }));
  const originalCreate = Shipment.create;
  Shipment.create = async data => { persisted = new Shipment(data); return persisted; };
  service.createShipment = async payload => { shipPayload = payload; return { order_id: 123, master_tracking_num: 'MOCK', tracking_url: '', documents: [] }; };
  try {
    const booked = await invoke(controller.bookShipment, { shipper: address, recipient: address, parcels: [parcel], packagingType: 'Pallet', selectedRate: quote.data.rates[0], shipmentType: 'domestic', references });
    assert.equal(booked.status, 201);
    assert.equal(await controller.generateLabelForShipment(persisted), true);
    assert.deepEqual(shipPayload.ship.references, references.map(r => ({ reference_name: r.referenceName, reference_value: r.referenceValue })));
    assert.deepEqual(shipPayload.ship.packaging_information, quotePayload.rate.packaging_information);
    assert.equal(shipPayload.ship.packaging_information.packages[0].special_handling, true);
    assert.equal(shipPayload.ship.packaging_information.packages[0].insurance_amount, 125);
    assert.equal(shipPayload.ship.packaging_information.packages[0].freight_class, '77.5');
  } finally { Shipment.create = originalCreate; }
});
test('internal order reference fills an unused slot only', async () => {
  let sent;
  service.createShipment = async payload => { sent = payload.ship; return { documents: [] }; };
  for (const count of [0, 1, 2]) {
    const references = Array.from({ length: count }, (_, n) => ({ referenceName: `Ref ${n}`, referenceValue: `${n}` }));
    await controller.generateLabelForShipment({ shipmentNumber: 'PC-TEST', shipper: address, recipient: address, parcels: [parcel], selectedRate: { serviceCode: '1' }, references });
    assert.equal(sent.references.length, count + 1);
    assert.deepEqual(sent.references[count], { reference_name: 'Order', reference_value: 'PC-TEST' });
  }
});
test('too many customer references are rejected before persistence', async () => {
  const result = await invoke(controller.bookShipment, { references: Array(4).fill({ referenceName: 'Ref', referenceValue: 'Value' }) });
  assert.equal(result.status, 400);
});
test('standard packages retain false handling and explicit zero insurance', () => {
  const result = service.buildPackagingInformation([{ ...parcel, specialHandling: false, insuranceAmount: 0, declaredValue: 999 }]);
  assert.equal(result.packages[0].special_handling, false);
  assert.equal(result.packages[0].insurance_amount, 0);
  assert.equal(result.packages[0].freight_class, undefined);
});
test('delivery date display is identical across timezones', () => {
  const script = `const exports = {};\n${frontendCode}\nprocess.stdout.write(exports.formatDeliveryDate('2026-09-30'));`;
  const results = ['America/Toronto', 'Asia/Karachi', 'Pacific/Honolulu', 'Pacific/Kiritimati'].map(TZ => execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' }));
  assert.equal(new Set(results).size, 1);
  assert.match(results[0], /30/);
  assert.equal(frontend.exports.formatDeliveryDate('2026-02-30'), '2026-02-30');
  assert.equal(frontend.exports.formatDeliveryDate('Pending'), 'Pending');
  assert.equal(normalizeDeliveryDate('30 September 2026'), '2026-09-30');
  assert.equal(normalizeDeliveryDate('2026-09-30T00:00:00+05:00'), '2026-09-30');
});
