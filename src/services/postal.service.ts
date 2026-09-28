import { isPostalLookupReady } from '../utils/postal';
export interface PostalResult {
  city: string;
  province: string;
  approximate?: boolean;
  cities?: string[];
  source?: string;
}

// OSM administrative levels differ by country. Explicit fallbacks prevent a
// lower-level municipality from being mistaken for a province. Retain level 4
// wherever it already supplies a country-matching subdivision.
const SUBDIVISION_FALLBACK_LEVELS: Record<string, readonly number[]> = {
  PT: [6],       // districts
  IS: [5],       // regions, not level-6 municipalities
  IE: [6],       // counties, not level-5 historical provinces
  HU: [6, 8],    // counties and county-status cities (including Budapest)
  GR: [5],       // administrative regions
  SI: [8],       // municipalities are the ISO subdivisions
  EE: [6],       // counties, not level-7 municipalities
  LV: [5],       // municipalities and state cities
  LU: [6],       // cantons
  CY: [5],       // districts
  RS: [6],       // districts, including Belgrade
  AL: [6],       // counties
  PH: [3],       // Metro Manila (00); other provinces already use level 4
};

function provinceCode(country: string, address: Record<string, unknown> | undefined): string {
  for (const level of [4, ...(SUBDIVISION_FALLBACK_LEVELS[country] || [])]) {
    const code = address?.[`ISO3166-2-lvl${level}`];
    // Metro Manila is accepted as a province-equivalent in address metadata;
    // other Philippine regions must not replace an unknown province.
    if (country === 'PH' && level === 3 && code !== 'PH-00') continue;
    if (typeof code === 'string' && new RegExp(`^${country}-[A-Z0-9]{1,3}$`).test(code)) {
      return code.slice(country.length + 1);
    }
  }
  return '';
}

function fallbackCity(place: any): string {
  // GeoNames adds district and government-mail qualifiers to municipality names.
  // Only normalize fallback labels; never rewrite the user's address here.
  return String(place['place name'] || '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\s+(?:Manitoba|New Brunswick|Prince Edward Island|Ontario|Quebec|Alberta|British Columbia|Nova Scotia|Saskatchewan|Newfoundland and Labrador) Provincial Government$/i, '')
    .replace(/^Downtown\s+/i, '')
    .replace(/\s+(North\s?East|North\s?West|South\s?East|South\s?West|North Central|South Central|Central|East|West|North|South)$/i, '')
    .trim();
}

// The ZIP database holds the USPS mailing city, which carriers check against the
// ZIP. Nominatim often has only the county (90001 → Los Angeles County) or a
// neighbouring municipality (60601 → Riverside Township instead of Chicago).
async function lookupUsZip(zip: string): Promise<PostalResult | null> {
  try {
    const response = await fetch(`https://api.zippopotam.us/US/${zip}`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return null;
    const data = await response.json() as any;
    const places: any[] = Array.isArray(data.places) ? data.places : [];
    // GeoNames names Manhattan "New York City"; the USPS name is "New York".
    const cities = [...new Set(places.map(p => String(p['place name'] || '').trim().replace(/^New York City$/i, 'New York')).filter(Boolean))];
    const states = [...new Set(places.map(p => String(p['state abbreviation'] || '')).filter(Boolean))];
    if (!cities.length) return null;
    return { city: cities.length === 1 ? cities[0] : '', province: states.length === 1 ? states[0] : '',
      source: 'zippopotam-zip', ...(cities.length > 1 ? { cities } : {}) };
  } catch { return null; }
}

// An FSA is an area, not address validation. Do not pick an arbitrary city
// when the fallback contains several municipalities.
export async function lookupPostal(country: string, postal: string): Promise<PostalResult> {
  country = country.trim().toUpperCase();
  postal = postal.trim().toUpperCase();
  const empty = { city: '', province: '' };
  if (!isPostalLookupReady(country, postal)) return empty;
  const compact = postal.replace(/\s/g, '');
  if (country === 'CA') {
    if (!/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/.test(compact)) return empty;
    postal = `${compact.slice(0, 3)} ${compact.slice(3)}`;
  }
  if (country === 'US') {
    const zip = await lookupUsZip(compact.slice(0, 5));
    if (zip) return zip;
  }
  let exact: PostalResult = empty;
  try {
    const query = new URLSearchParams({ postalcode: postal, countrycodes: country.toLowerCase(), format: 'json', addressdetails: '1', 'accept-language': 'en', limit: '1' });
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${query}`, {
      headers: { 'User-Agent': 'PilotCourier/1.0 (support@pilotcourier.com)' }, signal: AbortSignal.timeout(4000),
    });
    if (response.ok) {
      const results = await response.json() as any[];
      const a = results?.[0]?.address;
      exact = { city: a?.city || a?.town || a?.municipality || a?.village || '',
        province: provinceCode(country, a), source: 'nominatim' };
    }
  } catch { /* A timeout or provider outage must still allow the fallback. */ }
  if (country !== 'CA' || (exact.city && exact.province)) return exact;
  try {
    const response = await fetch(`https://api.zippopotam.us/CA/${compact.slice(0, 3)}`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return exact;
    const data = await response.json() as any;
    const places: any[] = Array.isArray(data.places) ? data.places : [];
    const cities = [...new Set(places.map(fallbackCity).filter(Boolean))];
    const provinces = [...new Set(places.map(p => String(p['state abbreviation'] || '')).filter(Boolean))];
    return { city: exact.city || (cities.length === 1 ? cities[0] : ''),
      province: exact.province || (provinces.length === 1 ? provinces[0] : ''), approximate: true, source: 'zippopotam-fsa', ...(cities.length > 1 ? { cities } : {}) };
  } catch { return exact; }
}
