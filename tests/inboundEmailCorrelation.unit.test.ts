import { generateReplyToken, parseReplyToken } from "../src/lib/inboundEmailCorrelation";
import { extractEmailAddress, extractDisplayName, addressesMatch, sanitizeFilename } from "../src/lib/emailAddressParsing";

describe("inboundEmailCorrelation -- generateReplyToken / parseReplyToken", () => {
  it("generates a hex token and round-trips through the reply-to address format", () => {
    const token = generateReplyToken();
    expect(token).toMatch(/^[a-f0-9]+$/);

    const parsed = parseReplyToken(`po-${token}@abc123.resend.app`);
    expect(parsed).toBe(token);
  });

  it("returns null for an address that doesn't match the expected shape", () => {
    expect(parseReplyToken("random@supplier.test")).toBeNull();
    expect(parseReplyToken("notpo-abc123@resend.app")).toBeNull();
    expect(parseReplyToken("po-@resend.app")).toBeNull();
  });

  it("generates unique tokens across calls", () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateReplyToken()));
    expect(tokens.size).toBe(20);
  });
});

describe("buildReplyToAddress -- env-driven (RESEND_INBOUND_DOMAIN present/absent)", () => {
  const original = process.env.RESEND_INBOUND_DOMAIN;

  afterEach(() => {
    process.env.RESEND_INBOUND_DOMAIN = original ?? "";
    jest.resetModules();
  });

  it("returns null when RESEND_INBOUND_DOMAIN is not configured", () => {
    jest.resetModules();
    process.env.RESEND_INBOUND_DOMAIN = "";
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildReplyToAddress } = require("../src/lib/inboundEmailCorrelation");
    expect(buildReplyToAddress("abc123")).toBeNull();
  });

  it("builds the full address when RESEND_INBOUND_DOMAIN is configured", () => {
    jest.resetModules();
    process.env.RESEND_INBOUND_DOMAIN = "xyz.resend.app";
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildReplyToAddress } = require("../src/lib/inboundEmailCorrelation");
    expect(buildReplyToAddress("abc123")).toBe("po-abc123@xyz.resend.app");
  });
});

describe("emailAddressParsing", () => {
  it("extractEmailAddress handles both 'Name <addr>' and bare address formats", () => {
    expect(extractEmailAddress("Ahmed Hassan <ahmed@supplier.test>")).toBe("ahmed@supplier.test");
    expect(extractEmailAddress("ahmed@supplier.test")).toBe("ahmed@supplier.test");
  });

  it("extractDisplayName returns the name or null", () => {
    expect(extractDisplayName("Ahmed Hassan <ahmed@supplier.test>")).toBe("Ahmed Hassan");
    expect(extractDisplayName("ahmed@supplier.test")).toBeNull();
    expect(extractDisplayName('"Ahmed Hassan" <ahmed@supplier.test>')).toBe("Ahmed Hassan");
  });

  it("addressesMatch is case-insensitive and trims whitespace", () => {
    expect(addressesMatch("Ahmed@Supplier.test", " ahmed@supplier.test ")).toBe(true);
    expect(addressesMatch("ahmed@supplier.test", "other@supplier.test")).toBe(false);
  });

  it("sanitizeFilename strips path separators, traversal sequences, and control characters, falls back on empty", () => {
    expect(sanitizeFilename("../../etc/passwd")).not.toContain("..");
    expect(sanitizeFilename("../../etc/passwd")).not.toContain("/");
    expect(sanitizeFilename("invoice.pdf")).toBe("invoice.pdf");
    expect(sanitizeFilename(null)).toBe("attachment");
    expect(sanitizeFilename("   ")).toBe("attachment");
    expect(sanitizeFilename("a\x00b.pdf")).toBe("ab.pdf");
  });
});
