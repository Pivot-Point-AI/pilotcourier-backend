# Address metadata

Snapshots retrieved 28 September 2026; the original 73-country postal metadata was captured on 27 September.

- `postal-formats.json`: 245 country/territory format records from Google libaddressinput's [address metadata service](https://chromium-i18n.appspot.com/ssl-address/data/CA). Format validation does not prove that a postal code is assigned or identify its municipality. Retired Netherlands Antilles (`AN`) has no metadata and is not accepted.
- `subdivisions.json`: country names from [CountriesNow](https://countriesnow.space/api/v0.1/countries/states), reconciled with [pycountry's ISO 3166-2 dataset](https://raw.githubusercontent.com/pycountry/pycountry/main/src/pycountry/databases/iso3166-2.json). Newly supported countries use ISO codes/names. The original 20 supported countries retain existing labels/codes, with missing ISO codes added. Values omit the country prefix. Countries without subdivisions legitimately have an empty list.

The backend serves province options from this snapshot, without depending on a live provider. All 70 audit countries have options; every nonempty province code in the 140-case replay has a matching option.

Postal rules are embedded in `src/utils/postal.ts` and the sibling frontend `src/lib/postal.ts` so both builds are independent. Update both from `postal-formats.json` together; tests enforce identical files, all 140 reference formats, invalid formats, leading zeros, three-character codes and US ZIP+4. Preserve the explicit compact US ZIP+4 compatibility rule. Refresh snapshots deliberately and rerun `npm run test:shipping`; do not infer missing city names from postal format alone.
