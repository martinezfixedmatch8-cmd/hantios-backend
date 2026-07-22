import worldCountries from "world-countries";
import currencyCodes from "currency-codes";

export interface CurrencyRecord {
  code: string;
  name: string;
  symbol: string | null;
  digits: number; // decimal precision / minor units, e.g. 2 for USD, 0 for JPY
}

// world-countries doesn't expose a flat currency list -- only per-country. Build
// a code -> symbol map once by scanning every country's `currencies` object
// (first match wins; in the rare case two countries disagree on a symbol for
// the same ISO code, that's an inherent ambiguity in the source data, not
// something to resolve by inventing a "canonical" one).
const symbolByCode = new Map<string, string>();
for (const country of worldCountries) {
  for (const [code, info] of Object.entries(country.currencies ?? {})) {
    if (!symbolByCode.has(code) && info.symbol) {
      symbolByCode.set(code, info.symbol);
    }
  }
}

// currency-codes is the ISO 4217 source of truth for the code/name/digits
// triad -- ~179 currently-active codes, ~50 more than world-countries' own
// currency map since it includes codes with no single-country association
// (e.g. XAU, XDR). Those simply have no symbol (null), not a fabricated one.
const allCurrencies: CurrencyRecord[] = currencyCodes.codes().map((code) => {
  const info = currencyCodes.code(code)!;
  return {
    code: info.code,
    name: info.currency,
    symbol: symbolByCode.get(code) ?? null,
    digits: info.digits,
  };
});

export function getAllCurrencies(): CurrencyRecord[] {
  return allCurrencies;
}

export function searchCurrencies(query: string): CurrencyRecord[] {
  const q = query.trim().toLowerCase();
  if (!q) return allCurrencies;
  return allCurrencies.filter((c) => c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
}

export function getCurrency(code: string): CurrencyRecord | undefined {
  return allCurrencies.find((c) => c.code === code.toUpperCase());
}
