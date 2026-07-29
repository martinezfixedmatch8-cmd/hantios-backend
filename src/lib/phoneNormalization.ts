import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { badRequest } from "./errors";

// Real, maintained library -- not a hand-rolled or Somalia-specific regex
// (same "real npm package, not hand-authored" rule this repo already
// applies to country/currency/timezone reference data). `business.country`
// is already the exact cca2 shape `defaultCountry` expects (the same field
// `getPhonePrefix` in countryReference.ts already keys off), so no
// conversion is needed at call sites.

export interface NormalizedPhone {
  original: string;
  normalized: string; // E.164
}

// Throws on an unparseable/invalid number -- silently storing a raw,
// un-normalized value would reopen the exact duplicate-customer problem
// phone normalization exists to close, so every write path must reject
// rather than degrade.
export function normalizePhone(raw: string, defaultCountry: string): NormalizedPhone {
  const original = raw.trim();
  const parsed = parsePhoneNumberFromString(original, defaultCountry as CountryCode);
  if (!parsed || !parsed.isValid()) {
    throw badRequest(`"${raw}" is not a valid phone number`);
  }
  return { original, normalized: parsed.number };
}

// Non-throwing variant for search -- an unparseable search term should fall
// back to the plain name/email/customer-number branches, not 400 the whole
// list request.
export function tryNormalizePhone(raw: string, defaultCountry: string): NormalizedPhone | null {
  try {
    return normalizePhone(raw, defaultCountry);
  } catch {
    return null;
  }
}
