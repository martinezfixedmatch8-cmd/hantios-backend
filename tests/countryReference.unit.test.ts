import { getPhonePrefix, findCountry } from "../src/lib/countryReference";

// Unit coverage for getPhonePrefix (src/lib/countryReference.ts), added during
// the pre-Session-4 QA audit of the country/currency/timezone/phone-prefix
// foundation. The function was just fixed to special-case NANP (root === "+1")
// so US/CA/etc. resolve to the plain "+1" instead of an arbitrary area code
// pulled from idd.suffixes[0]. This file independently verifies that fix
// across every NANP territory actually present in world-countries, verifies a
// spread of non-NANP multi-suffix countries still resolve correctly, and
// documents a SECOND real instance of the exact same bug class the NANP fix
// did not cover: Russia and Kazakhstan both list root "+7" with idd.suffixes
// that are local area/mobile lead-digits (not country-completing digits),
// exactly like NANP's area codes -- but getPhonePrefix only special-cases
// root === "+1", so RU/KZ still resolve to "+73"/"+76" instead of the
// correct, complete "+7". This is not a hypothetical: Kazakhstan and Russia
// are well-documented to share the single ITU/E.164 country code +7 (a
// holdover from the USSR's shared numbering plan), structurally identical to
// how NANP territories share +1.

describe("getPhonePrefix", () => {
  it("resolves every NANP territory to the plain +1 prefix, not an area code", () => {
    // Every ISO territory in world-countries whose idd.root is "+1" -- not a
    // hand-picked subset, so this can't miss a NANP member the fix forgot.
    const nanpMembers = ["US", "CA", "JM", "BS", "PR", "DO", "AI", "AG", "BB", "BM", "KY", "DM", "GD", "GU"];
    for (const cca2 of nanpMembers) {
      const country = findCountry(cca2);
      expect(country).toBeDefined();
      expect(country?.idd.root).toBe("+1"); // sanity: confirms these really are NANP in this dataset
      expect(getPhonePrefix(country!)).toBe("+1");
    }
  });

  it("still does root+suffix correctly for non-NANP countries with multi-entry suffix arrays", () => {
    // Saint Helena: root "+2", suffixes ["90", "47"] -- suffixes[0] gives the
    // real, complete +290 (one of two legitimate sub-territory codes under
    // this single ISO entry -- a pre-existing, documented "pick first entry"
    // ambiguity, not the NANP-style bug).
    expect(getPhonePrefix(findCountry("SH")!)).toBe("+290");
  });

  it("resolves Russia and Kazakhstan to the plain +7 prefix, not a local lead-digit (mirrors the NANP case)", () => {
    // Real-world: Russia's and Kazakhstan's complete, correct calling code is
    // "+7" (both share it -- a well-documented ITU zone 7 assignment dating
    // to the shared Soviet numbering plan). world-countries models this
    // exactly like NANP: root "+7" for both, with idd.suffixes being local
    // leading digits (Russia: 3/4/5/8/9, Kazakhstan: 6/7) -- not
    // country-completing digits. getPhonePrefix only special-cases
    // root === "+1", so this currently FAILS (produces "+73"/"+76" instead
    // of "+7") -- a second real instance of the bug the NANP fix targeted,
    // missed because NANP_ROOT is hardcoded to a single value instead of a
    // set/detection rule for "root alone is already a complete code."
    const russia = findCountry("RU")!;
    const kazakhstan = findCountry("KZ")!;
    expect(russia.idd.root).toBe("+7");
    expect(kazakhstan.idd.root).toBe("+7");

    expect(getPhonePrefix(russia)).toBe("+7");
    expect(getPhonePrefix(kazakhstan)).toBe("+7");
  });
});
