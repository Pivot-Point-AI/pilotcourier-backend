const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript');
const frontend = path.resolve(__dirname, '../../frontend/src');
const code = ts.transpileModule(fs.readFileSync(path.join(frontend, 'lib/postal.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const scope = { exports: {} }; vm.runInNewContext(code, scope);
const { isPostalLookupReady, isPostalFormatValid } = scope.exports;
test('three and four character formats trigger lookup without allowing partial Canada', () => {
  for (const [country, postal] of [['IS','320'],['TW','104'],['AU','2060'],['BD','1000'],['NO','0107'],['CA','m5v 3a8'],['PK','17200']]) {
    assert.equal(isPostalLookupReady(country, postal), true);
    assert.equal(isPostalFormatValid(country, postal), true);
  }
  for (const [country, postal] of [['IS','32'],['TW','10'],['CA','M5V'],['CA','M5V 3'],['CA','M5V3A'],['','320']]) {
    assert.equal(isPostalLookupReady(country, postal), false);
  }
});
test('US ZIP+4 accepts hyphenated and existing compact forms while rejecting incomplete input', () => {
  for (const value of ['00501','22162-1010','221621010',' 22162-1010 ','22162 1010']) {
    assert.equal(isPostalFormatValid('US', value), true, value);
  }
  for (const value of ['2216','22162-','22162-101','22162--1010','22162-10101','ABCDE','22162x1010']) {
    assert.equal(isPostalFormatValid('US', value), false, value);
  }
});
test('all 140 original reference formats remain accepted and lookup-ready', () => {
  for (const row of require('./fixtures/postal-70-country.json').fixtures) {
    assert.equal(isPostalLookupReady(row.country, row.postal), true, row.country + ' ' + row.postal);
    assert.equal(isPostalFormatValid(row.country, row.postal), true, row.country + ' ' + row.postal);
  }
});
test('all address forms call the shared lookup helper and Quick Quote calls shared validation', () => {
  for (const relative of ['app/quote/QuoteClient.tsx','components/sections/QuoteForm.tsx','app/booking/_components/AddressPanel.tsx']) {
    assert.match(fs.readFileSync(path.join(frontend,relative),'utf8'), /!isPostalLookupReady\(country, (postal|val)\)/);
  }
  const quote = fs.readFileSync(path.join(frontend,'app/quote/QuoteClient.tsx'),'utf8');
  assert.match(quote,/isPostalFormatValid\(form.originCountry, form.originPostal\)/);
  assert.match(quote,/isPostalFormatValid\(form.destinationCountry, form.destinationPostal\)/);
});
