import worldCountries from "world-countries";
import type { Country } from "world-countries";
import { getTimezonesForCountry, getTimezone } from "countries-and-timezones";
import { badRequest } from "./errors";

export interface CountryDefaults {
  currency: string;
  timezone: string;
  phonePrefix: string;
}

export interface CountryTimezone {
  name: string; // IANA identifier -- the only authoritative field here
  city: string; // display convenience only, mechanically derived from `name`
  // (e.g. "America/New_York" -> "New York") -- explicitly NOT a "major city"
  // dataset (no population/lat-long/official-designation data backs this),
  // never to be treated as one. Locked decision, see CLAUDE.md.
  utcOffset: number; // minutes
  utcOffsetStr: string;
  dstOffset: number;
  dstOffsetStr: string;
}

function deriveCityLabel(zoneName: string): string {
  const last = zoneName.split("/").pop() ?? zoneName;
  return last.replace(/_/g, " ");
}

// world-countries splits each country's real dialing code into idd.root +
// idd.suffixes, and for the vast majority of countries the suffix genuinely
// completes a code unique to that country (Kenya "+2"+"54"="+254", France
// "+3"+"3"="+33") -- root+suffix[0] is correct there. But there are exactly
// two real, well-documented telephony exceptions where the ITU E.164 country
// calling code itself is IDENTICAL across multiple sovereign ISO territories,
// with no country-level digit beyond the root at all:
//   - NANP ("+1"): ~25 territories (US, Canada, Jamaica, Bahamas, Puerto
//     Rico, ...) all share the complete code "+1". idd.suffixes there is each
//     territory's local AREA code (a subscriber-routing detail, not part of
//     the country code) -- e.g. naively appending the first one produces
//     "+1201" for the United States instead of the correct "+1".
//   - Russia/Kazakhstan ("+7"): both share the complete code "+7" (a holdover
//     from the USSR-era numbering plan); idd.suffixes there are internal
//     trunk-prefix digits, not country-code digits.
// This can't be derived generically from the root+suffix *shape* alone --
// verified this by checking every one of this dataset's other shared-root
// groups (+2 through +9, excluding +1/+7): those DO sometimes have multiple
// countries landing on an identical root+suffix (e.g. Réunion/Mayotte both
// "+262", the UK/Guernsey/Isle of Man/Jersey all "+44") -- but there,
// root+suffix genuinely IS each of their real, complete, correctly-shared
// code (dropping to the bare root would be wrong for them, unlike NANP/+7).
// So this is an explicit, small, stable, real-world exception list -- not a
// hand-invented value, and not something the dataset's own shape can safely
// generalize from.
const ROOT_ALONE_IS_COMPLETE_CODE = new Set(["+1", "+7"]);

export function getPhonePrefix(country: Country): string | null {
  if (!country.idd?.root) return null;
  if (ROOT_ALONE_IS_COMPLETE_CODE.has(country.idd.root)) return country.idd.root;
  const suffix = country.idd.suffixes?.[0] ?? "";
  return `${country.idd.root}${suffix}`;
}

// Every dialing prefix that's actually valid for a country -- not just the
// single default getPhonePrefix picks. Root-alone countries (NANP/+7) only
// have one valid answer (the shared root); every other country in this
// dataset has at most a handful of suffixes (verified -- none exceed 3
// outside the root-alone cases), so this stays a small, sane list.
export function getValidPhonePrefixes(country: Country): string[] {
  if (!country.idd?.root) return [];
  if (ROOT_ALONE_IS_COMPLETE_CODE.has(country.idd.root)) return [country.idd.root];
  const suffixes = country.idd.suffixes?.length ? country.idd.suffixes : [""];
  return suffixes.map((s) => `${country.idd!.root}${s}`);
}

export function isValidPhonePrefixForCountry(countryCode: string, phonePrefix: string): boolean {
  const country = findCountry(countryCode);
  if (!country) return false;
  return getValidPhonePrefixes(country).includes(phonePrefix);
}

export function getAllCountries(): readonly Country[] {
  return worldCountries;
}

export function findCountry(countryCode: string): Country | undefined {
  return worldCountries.find((c) => c.cca2 === countryCode.toUpperCase());
}

// Canonical zones only (matches getCountryDefaults' own choice of "first
// entry") -- for populating a picker UI, where offering both "Africa/Nairobi"
// and its deprecated alias "Africa/Mogadishu" as separate options would be
// confusing noise, not a real choice (they're the same civil time).
export function getCountryTimezones(countryCode: string): CountryTimezone[] {
  const country = findCountry(countryCode);
  if (!country) {
    throw badRequest(`Unknown country code: ${countryCode}`);
  }
  const timezones = getTimezonesForCountry(country.cca2) ?? [];
  return timezones.map((tz) => ({
    name: tz.name,
    city: deriveCityLabel(tz.name),
    utcOffset: tz.utcOffset,
    utcOffsetStr: tz.utcOffsetStr,
    dstOffset: tz.dstOffset,
    dstOffsetStr: tz.dstOffsetStr,
  }));
}

// Deliberately more lenient than getCountryTimezones: resolves the submitted
// zone directly (so a legitimate-but-deprecated alias like "Africa/Mogadishu"
// for Somalia is correctly accepted, not just the canonical "Africa/Nairobi"
// getCountryTimezones would list) and checks its own country association.
export function isValidTimezoneForCountry(countryCode: string, timezone: string): boolean {
  const tz = getTimezone(timezone);
  if (!tz) return false;
  // countries-and-timezones types `.countries` as a literal union of its own
  // known codes; the input here is an arbitrary runtime string (already
  // shaped, not necessarily validated against that exact union), so widen for
  // the membership check rather than importing its internal CountryCode type.
  return (tz.countries as readonly string[]).includes(countryCode.toUpperCase());
}

// Two packages because neither alone covers currency + timezone + calling code (verified,
// not assumed). Where a country has more than one of something (e.g. multiple timezones or
// dial-code suffixes), we pick the first entry -- acceptable because these are only *defaults*;
// the signup request can always override currency/timezone/phonePrefix explicitly.
export function getCountryDefaults(countryCode: string): CountryDefaults {
  const country = worldCountries.find((c) => c.cca2 === countryCode.toUpperCase());
  if (!country) {
    throw badRequest(`Unknown country code: ${countryCode}`);
  }

  const currency = Object.keys(country.currencies ?? {})[0];
  if (!currency) {
    throw badRequest(`No currency data for country code: ${countryCode}`);
  }

  const timezones = getTimezonesForCountry(country.cca2);
  const timezone = timezones?.[0]?.name;
  if (!timezone) {
    throw badRequest(`No timezone data for country code: ${countryCode}`);
  }

  const phonePrefix = getPhonePrefix(country);
  if (!phonePrefix) {
    throw badRequest(`No phone prefix data for country code: ${countryCode}`);
  }

  return { currency, timezone, phonePrefix };
}
