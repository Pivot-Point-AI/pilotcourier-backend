interface DisplayRate {
  currency: string;
  totalCharge: number;
  transitDays: number;
}

// Amounts can only be compared within the same currency without an FX quote.
export function tagRates<T extends DisplayRate>(rates: T[]) {
  const fastestDays = Math.min(...rates.map(rate => rate.transitDays));
  const currencies = [...new Set(rates.map(rate => rate.currency))].sort();
  return currencies.flatMap(currency => {
    const group = rates.filter(rate => rate.currency === currency)
      .sort((a, b) => a.totalCharge - b.totalCharge);
    const best = group.reduce((a, b) =>
      a.totalCharge / Math.max(a.transitDays, 1) < b.totalCharge / Math.max(b.transitDays, 1) ? a : b);
    return group.map((rate, index) => ({
      ...rate,
      isCheapest: index === 0,
      isFastest: rate.transitDays === fastestDays,
      isBestValue: rate === best,
    }));
  });
}

// A carrier delivery day is a calendar date, not an instant to convert to UTC.
export function normalizeDeliveryDate(value: string): string {
  if (!value) return '';
  const iso = value.match(/^(\d{4}-\d{2}-\d{2})(?:$|[T ])/);
  if (iso) return iso[1];
  const named = value.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:$|\s)/);
  if (named) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = months.indexOf(named[2].slice(0, 3).toLowerCase());
    const day = Number(named[1]);
    const date = new Date(Date.UTC(Number(named[3]), month, day));
    if (month >= 0 && date.getUTCMonth() === month && date.getUTCDate() === day) {
      return date.toISOString().slice(0, 10);
    }
  }
  return value;
}
