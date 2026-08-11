import { renderReceiptText, formatIssuedAtLocal, RECEIPT_RENDERER_VERSION } from "../src/lib/receiptRenderer";
import type { ReceiptSnapshot } from "../src/lib/receiptSnapshot";

function baseInput(overrides: Partial<Parameters<typeof renderReceiptText>[0]> = {}) {
  const snapshot: ReceiptSnapshot = {
    business: { name: "Acme Shop", address: "123 Main St", logoUrl: null },
    items: [{ productName: "Widget", size: null, quantity: "2", unitPrice: "10.00", lineTotal: "20.00" }],
    paymentMethod: "Cash",
  };
  return {
    receiptNumber: "RCP-2026-000001",
    receiptType: "sale",
    status: "issued",
    issuedAtLocal: "11 Aug 2026, 14:05:22",
    currencyCode: "KES",
    subtotal: "20.00",
    discount: "0",
    taxAmount: "0",
    feeAmount: "0",
    total: "20.00",
    language: "en",
    snapshot,
    ...overrides,
  };
}

describe("receiptRenderer", () => {
  it("is deterministic -- identical input always produces identical output", () => {
    const input = baseInput();
    expect(renderReceiptText(input)).toBe(renderReceiptText(input));
  });

  it("renders in all 5 supported languages without throwing, each producing distinct label text", () => {
    const outputs = (["en", "so", "ar", "fr", "es"] as const).map((language) => renderReceiptText(baseInput({ language })));
    expect(new Set(outputs).size).toBe(5);
  });

  it("falls back to English for an unsupported language", () => {
    const unsupported = renderReceiptText(baseInput({ language: "zz" }));
    const english = renderReceiptText(baseInput({ language: "en" }));
    expect(unsupported).toBe(english);
  });

  it("includes debt-payment context, distinguishing full vs partial", () => {
    const fullSnapshot: ReceiptSnapshot = {
      business: { name: "Acme", address: null, logoUrl: null },
      items: [{ productName: "Debt Payment", size: null, quantity: "1", unitPrice: "100", lineTotal: "100" }],
      paymentMethod: "Cash",
      debtPayment: { amountOriginal: "100", amountPaidTotal: "100", remainingBalance: "0", isFullPayment: true, isReversal: false },
    };
    const partialSnapshot: ReceiptSnapshot = {
      ...fullSnapshot,
      debtPayment: { amountOriginal: "100", amountPaidTotal: "40", remainingBalance: "60", isFullPayment: false, isReversal: false },
    };
    const fullText = renderReceiptText(baseInput({ snapshot: fullSnapshot }));
    const partialText = renderReceiptText(baseInput({ snapshot: partialSnapshot }));
    expect(fullText).not.toBe(partialText);
    expect(fullText).toContain("Payment in Full");
    expect(partialText).toContain("Partial Payment");
  });

  it("never recalculates -- financial values in the output come straight from input, never derived", () => {
    const text = renderReceiptText(baseInput({ subtotal: "999.99", total: "999.99" }));
    expect(text).toContain("999.99");
  });

  it("RECEIPT_RENDERER_VERSION is a stable positive integer", () => {
    expect(RECEIPT_RENDERER_VERSION).toBeGreaterThan(0);
  });
});

describe("formatIssuedAtLocal", () => {
  it("formats deterministically for a fixed (issuedAt, timezone) pair", () => {
    const d = new Date("2026-08-11T10:00:00.000Z");
    const a = formatIssuedAtLocal(d, "Africa/Nairobi");
    const b = formatIssuedAtLocal(d, "Africa/Nairobi");
    expect(a).toBe(b);
  });

  it("produces different output for different timezones given the same instant", () => {
    const d = new Date("2026-08-11T10:00:00.000Z");
    const nairobi = formatIssuedAtLocal(d, "Africa/Nairobi");
    const newYork = formatIssuedAtLocal(d, "America/New_York");
    expect(nairobi).not.toBe(newYork);
  });

  it("never throws on an invalid timezone string, falls back to a UTC ISO string", () => {
    const d = new Date("2026-08-11T10:00:00.000Z");
    expect(() => formatIssuedAtLocal(d, "Not/A_Real_Zone")).not.toThrow();
    expect(formatIssuedAtLocal(d, "Not/A_Real_Zone")).toBe(d.toISOString());
  });
});
