export interface PostalResult {
  city: string;
  province: string;
  approximate?: boolean;
  cities?: string[];
  source?: string;
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

// An FSA is an area, not address validation. Do not pick an arbitrary city
// when the fallback contains several municipalities.
export async function lookupPostal(country: string, postal: string): Promise<PostalResult> {
  country = country.trim().toUpperCase();
  postal = postal.trim().toUpperCase();
  const empty = { city: '', province: '' };
  const compact = postal.replace(/\s/g, '');
  if (country === 'CA') {
    if (!/^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/.test(compact)) return empty;
    postal = `${compact.slice(0, 3)} ${compact.slice(3)}`;
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
        // Match the country subdivision codes used by the province dropdown.
        // Do not substitute county/district names for a missing province code.
        province: typeof a?.['ISO3166-2-lvl4'] === 'string' && a['ISO3166-2-lvl4'].startsWith(`${country}-`)
          ? a['ISO3166-2-lvl4'].slice(country.length + 1) : '', source: 'nominatim' };
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
