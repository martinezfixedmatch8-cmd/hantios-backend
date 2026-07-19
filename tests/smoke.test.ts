// Verifies the Jest + ts-jest toolchain is wired correctly.
// Replace with real test suites once src/ has actual modules to test.
describe("toolchain smoke test", () => {
  it("runs TypeScript tests", () => {
    const value: number = 1 + 1;
    expect(value).toBe(2);
  });
});
