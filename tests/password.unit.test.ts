import { passwordSchema } from "../src/lib/password";

// Batch 2 remediation (HNT-PWD-001) -- passwordSchema previously had no
// upper bound at all.
describe("passwordSchema max length (HNT-PWD-001)", () => {
  function validExcept(length: number): string {
    // Aa1! prefix guarantees every character-class regex still passes;
    // padded with a repeating letter to hit the exact target length.
    const prefix = "Aa1!";
    return prefix + "b".repeat(Math.max(0, length - prefix.length));
  }

  it("accepts a password at exactly the 128-character boundary", () => {
    const result = passwordSchema.safeParse(validExcept(128));
    expect(result.success).toBe(true);
  });

  it("rejects a password one character over the 128-character boundary", () => {
    const result = passwordSchema.safeParse(validExcept(129));
    expect(result.success).toBe(false);
  });

  it("still enforces the existing minimum length and complexity rules unchanged", () => {
    expect(passwordSchema.safeParse("Aa1!").success).toBe(false); // too short
    expect(passwordSchema.safeParse("alllowercase1!").success).toBe(false); // no uppercase
    expect(passwordSchema.safeParse("Str0ng!Passw0rd").success).toBe(true);
  });
});
