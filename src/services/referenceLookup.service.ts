import type { Country } from "world-countries";
import { getTimezonesForCountry } from "countries-and-timezones";
import { getAllCountries, findCountry, getCountryTimezones, getPhonePrefix } from "../lib/countryReference";
import { searchCurrencies, type CurrencyRecord } from "../lib/currencyReference";
import { notFound } from "../lib/errors";
import type { CountryTimezone } from "../lib/countryReference";

export interface CountrySummary {
  name: string;
  officialName: string;
  cca2: string;
  cca3: string;
  ccn3: string | null;
  phonePrefix: string | null;
  currencyCode: string | null;
  flag: string;
  capital: string | null;
  region: string;
  subregion: string | null;
  language: string | null;
  defaultTimezone: string | null;
}

// A few territories genuinely have no currency/calling-code/timezone data
// (uninhabited islands, etc.) -- real gaps in reality, not defects in the
// source dataset. Fields are null there, never fabricated.
function toSummary(country: Country): CountrySummary {
  const phonePrefix = getPhonePrefix(country);
  const currencyCode = Object.keys(country.currencies ?? {})[0] ?? null;
  const defaultTimezone = getTimezonesForCountry(country.cca2)?.[0]?.name ?? null;

  return {
    name: country.name.common,
    officialName: country.name.official,
    cca2: country.cca2,
    cca3: country.cca3,
    ccn3: country.ccn3 ?? null,
    phonePrefix,
    currencyCode,
    flag: country.flag,
    capital: country.capital?.[0] ?? null,
    region: country.region,
    subregion: country.subregion || null,
    language: Object.values(country.languages ?? {})[0] ?? null,
    defaultTimezone,
  };
}

const allCountrySummaries: CountrySummary[] = getAllCountries().map(toSummary);

// Bidirectional search: name, ISO alpha-2/alpha-3, or phone prefix, matching
// any direction ("Som"->Somalia, "SO"->Somalia, "+252"->Somalia, "+1"->both
// US and Canada).
export function searchCountries(query: string): CountrySummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return allCountrySummaries;
  return allCountrySummaries.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.officialName.toLowerCase().includes(q) ||
      c.cca2.toLowerCase() === q ||
      c.cca3.toLowerCase() === q ||
      (c.phonePrefix?.toLowerCase().includes(q) ?? false)
  );
}

export function getCountryTimezoneList(countryCode: string): CountryTimezone[] {
  if (!findCountry(countryCode)) {
    throw notFound(`Unknown country code: ${countryCode}`);
  }
  return getCountryTimezones(countryCode);
}

export function searchCurrencyReference(query: string): CurrencyRecord[] {
  return searchCurrencies(query);
}
