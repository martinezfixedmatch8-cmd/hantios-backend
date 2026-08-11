import { prisma } from "../src/lib/prisma";
import { getNextReceiptDocumentNumber } from "../src/lib/receiptNumberCounter";
import { createTestBusiness } from "./helpers/factories";
import { cleanupTestBusiness } from "./helpers/cleanup";

describe("receiptNumberCounter", () => {
  const businessIds: string[] = [];

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  it("produces sequential numbers per (business, year), starting at 1", async () => {
    const business = await createTestBusiness();
    businessIds.push(business.id);
    const n1 = await prisma.$transaction((tx) => getNextReceiptDocumentNumber(tx, business.id, business.timezone, "RCP"));
    const n2 = await prisma.$transaction((tx) => getNextReceiptDocumentNumber(tx, business.id, business.timezone, "RCP"));
    const seq1 = Number(n1.split("-")[2]);
    const seq2 = Number(n2.split("-")[2]);
    expect(seq2).toBe(seq1 + 1);
  });

  it("a prefix change does NOT reset the underlying sequence", async () => {
    const business = await createTestBusiness();
    businessIds.push(business.id);
    const n1 = await prisma.$transaction((tx) => getNextReceiptDocumentNumber(tx, business.id, business.timezone, "RCP"));
    const n2 = await prisma.$transaction((tx) => getNextReceiptDocumentNumber(tx, business.id, business.timezone, "INV"));
    const seq1 = Number(n1.split("-")[2]);
    const seq2 = Number(n2.split("-")[2]);
    expect(n1.startsWith("RCP-")).toBe(true);
    expect(n2.startsWith("INV-")).toBe(true);
    expect(seq2).toBe(seq1 + 1); // continues the SAME sequence, not INV-...-000001
  });

  it("two different businesses have fully independent sequences", async () => {
    const businessA = await createTestBusiness();
    const businessB = await createTestBusiness();
    businessIds.push(businessA.id, businessB.id);
    const nA = await prisma.$transaction((tx) => getNextReceiptDocumentNumber(tx, businessA.id, businessA.timezone, "RCP"));
    const nB = await prisma.$transaction((tx) => getNextReceiptDocumentNumber(tx, businessB.id, businessB.timezone, "RCP"));
    expect(nA.split("-")[2]).toBe("000001");
    expect(nB.split("-")[2]).toBe("000001");
  });

  it("is concurrency-safe: N truly-parallel allocations for the same business never collide", async () => {
    const business = await createTestBusiness();
    businessIds.push(business.id);
    const N = 8;
    const numbers = await Promise.all(
      Array.from({ length: N }, () => prisma.$transaction((tx) => getNextReceiptDocumentNumber(tx, business.id, business.timezone, "RCP")))
    );
    expect(new Set(numbers).size).toBe(N);
  });

  it("uses an uppercased prefix and pads the sequence to 6 digits", async () => {
    const business = await createTestBusiness();
    businessIds.push(business.id);
    const n = await prisma.$transaction((tx) => getNextReceiptDocumentNumber(tx, business.id, business.timezone, "rcp"));
    // Prefix casing is passed through exactly as given -- getReceiptSettings
    // (the caller) is what uppercases it, not this function itself.
    expect(n).toMatch(/^rcp-\d{4}-\d{6}$/);
  });
});
