import { prisma } from "../src/lib/prisma";
import { getNextCustomerNumber } from "../src/lib/customerNumber";
import { cleanupTestBusiness } from "./helpers/cleanup";
import { signupTestOwner } from "./helpers/factories";

describe("getNextCustomerNumber", () => {
  const businessIds: string[] = [];

  afterAll(async () => {
    await Promise.all(businessIds.map((id) => cleanupTestBusiness(id)));
    await prisma.$disconnect();
  });

  it("formats as CUS-###### and increments sequentially per business, starting at 1", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);

    const first = await prisma.$transaction((tx) => getNextCustomerNumber(tx, owner.businessId));
    const second = await prisma.$transaction((tx) => getNextCustomerNumber(tx, owner.businessId));
    const third = await prisma.$transaction((tx) => getNextCustomerNumber(tx, owner.businessId));

    expect(first).toBe("CUS-000001");
    expect(second).toBe("CUS-000002");
    expect(third).toBe("CUS-000003");
  });

  it("keeps separate businesses on separate sequences, each starting at 1", async () => {
    const ownerA = await signupTestOwner();
    businessIds.push(ownerA.businessId);
    const ownerB = await signupTestOwner();
    businessIds.push(ownerB.businessId);

    const aFirst = await prisma.$transaction((tx) => getNextCustomerNumber(tx, ownerA.businessId));
    const bFirst = await prisma.$transaction((tx) => getNextCustomerNumber(tx, ownerB.businessId));
    const aSecond = await prisma.$transaction((tx) => getNextCustomerNumber(tx, ownerA.businessId));

    expect(aFirst).toBe("CUS-000001");
    expect(bFirst).toBe("CUS-000001"); // independent sequence, unaffected by A's own count
    expect(aSecond).toBe("CUS-000002");
  });

  it("never issues the same number twice under real concurrency", async () => {
    const owner = await signupTestOwner();
    businessIds.push(owner.businessId);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => prisma.$transaction((tx) => getNextCustomerNumber(tx, owner.businessId)))
    );

    expect(new Set(results).size).toBe(8); // all 8 unique
    expect(results.sort()).toEqual(Array.from({ length: 8 }, (_, i) => `CUS-${String(i + 1).padStart(6, "0")}`).sort());
  });
});
