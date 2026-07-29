import { normalizePhone, tryNormalizePhone } from "../src/lib/phoneNormalization";

describe("normalizePhone", () => {
  it("normalizes local and E.164 formats of the same Kenyan number to the same E.164 value", () => {
    expect(normalizePhone("0712345678", "KE").normalized).toBe("+254712345678");
    expect(normalizePhone("+254712345678", "KE").normalized).toBe("+254712345678");
    expect(normalizePhone("254712345678", "KE").normalized).toBe("+254712345678");
  });

  // NANP (+1) is the exact real-world edge case this repo already has a
  // documented, regression-tested precedent for (getPhonePrefix's
  // ROOT_ALONE_IS_COMPLETE_CODE set, see countryReference.ts/CLAUDE.md) --
  // worth covering here too since libphonenumber-js is a separate library
  // from the reference-data packages that precedent lives in.
  it("normalizes a NANP (+1) number in multiple local formats to the same E.164 value", () => {
    expect(normalizePhone("(201) 555-0123", "US").normalized).toBe("+12015550123");
    expect(normalizePhone("2015550123", "US").normalized).toBe("+12015550123");
    expect(normalizePhone("+12015550123", "US").normalized).toBe("+12015550123");
  });

  it("normalizes a third, non-+1/+7 country consistently across formats", () => {
    expect(normalizePhone("020 7946 0958", "GB").normalized).toBe("+442079460958");
    expect(normalizePhone("+442079460958", "GB").normalized).toBe("+442079460958");
  });

  it("preserves the raw input verbatim (trimmed) as `original`", () => {
    expect(normalizePhone("  0712345678  ", "KE").original).toBe("0712345678");
  });

  it("throws a 400 badRequest error for an unparseable phone number", () => {
    expect(() => normalizePhone("not a phone number at all", "KE")).toThrow(/not a valid phone number/);
    try {
      normalizePhone("123", "KE");
      fail("expected normalizePhone to throw");
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).toBe(400);
    }
  });
});

describe("tryNormalizePhone", () => {
  it("returns the normalized result for a valid number", () => {
    expect(tryNormalizePhone("0712345678", "KE")?.normalized).toBe("+254712345678");
  });

  it("returns null (does not throw) for an unparseable phone number", () => {
    expect(tryNormalizePhone("not a phone number at all", "KE")).toBeNull();
    expect(tryNormalizePhone("123", "KE")).toBeNull();
  });
});
