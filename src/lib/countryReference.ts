import worldCountries from "world-countries";
import { getTimezonesForCountry } from "countries-and-timezones";
import { badRequest } from "./errors";

export interface CountryDefaults {
  currency: string;
  timezone: string;
  phonePrefix: string;
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

  const suffix = country.idd?.suffixes?.[0] ?? "";
  const phonePrefix = `${country.idd?.root ?? ""}${suffix}`;
  if (!phonePrefix) {
    throw badRequest(`No phone prefix data for country code: ${countryCode}`);
  }

  return { currency, timezone, phonePrefix };
}
