import { Prisma } from "@prisma/client";
import { classifyStockSeverity, evaluateStockAlertTransition } from "../src/lib/stockAlerts";

const d = (value: number) => new Prisma.Decimal(value);

describe("classifyStockSeverity", () => {
  const minStockLevel = d(10);

  it("returns null when quantity is above minStockLevel", () => {
    expect(classifyStockSeverity(d(11), minStockLevel)).toBeNull();
  });

  it("returns 'low' exactly at minStockLevel", () => {
    expect(classifyStockSeverity(d(10), minStockLevel)).toBe("low");
  });

  it("returns 'low' just above the critical boundary (minStockLevel/2)", () => {
    expect(classifyStockSeverity(d(6), minStockLevel)).toBe("low");
  });

  it("returns 'critical' exactly at minStockLevel/2", () => {
    expect(classifyStockSeverity(d(5), minStockLevel)).toBe("critical");
  });

  it("returns 'critical' just above zero", () => {
    expect(classifyStockSeverity(d(1), minStockLevel)).toBe("critical");
  });

  it("returns 'out_of_stock' at exactly zero", () => {
    expect(classifyStockSeverity(d(0), minStockLevel)).toBe("out_of_stock");
  });

  it("returns 'out_of_stock' for a negative quantity", () => {
    expect(classifyStockSeverity(d(-1), minStockLevel)).toBe("out_of_stock");
  });

  it("evaluates most-severe-first: out_of_stock still wins when minStockLevel/2 would also match", () => {
    // minStockLevel/2 = 0, so quantity 0 satisfies both the out_of_stock and
    // the critical condition -- out_of_stock must win, not critical.
    expect(classifyStockSeverity(d(0), d(0))).toBe("out_of_stock");
  });
});

describe("evaluateStockAlertTransition", () => {
  it("returns 'entered' when inactive and severity newly applies, on a decrease", () => {
    expect(evaluateStockAlertTransition(false, "low", "decrease")).toBe("entered");
    expect(evaluateStockAlertTransition(false, "critical", "decrease")).toBe("entered");
    expect(evaluateStockAlertTransition(false, "out_of_stock", "decrease")).toBe("entered");
  });

  it("returns null when inactive and still above threshold", () => {
    expect(evaluateStockAlertTransition(false, null, "decrease")).toBeNull();
    expect(evaluateStockAlertTransition(false, null, "increase")).toBeNull();
  });

  it("returns 'recovered' when active and severity clears, regardless of direction", () => {
    expect(evaluateStockAlertTransition(true, null, "increase")).toBe("recovered");
    expect(evaluateStockAlertTransition(true, null, "decrease")).toBe("recovered");
  });

  it("returns null when active and severity escalates (low -> critical) -- not a new transition", () => {
    expect(evaluateStockAlertTransition(true, "critical", "decrease")).toBeNull();
  });

  it("returns null when active and severity stays the same", () => {
    expect(evaluateStockAlertTransition(true, "low", "decrease")).toBeNull();
  });

  // Regression: QA reproduced this live (real DB) via PATCH /products/:id
  // raising minStockLevel after a row went stale-inactive above the OLD
  // threshold, then a plain stock-adjustment increase -- which illegally
  // fired StockLow. Severity is normally monotonic in quantity, so an
  // increase should never be able to produce "entered" on its own, but that
  // assumption silently breaks the moment minStockLevel itself changes
  // between debounce evaluations. This gate holds regardless of *why*
  // severity newly applies while inactive -- not just for that one repro.
  it("never returns 'entered' on an increase, even when severity newly applies while inactive", () => {
    expect(evaluateStockAlertTransition(false, "low", "increase")).toBeNull();
    expect(evaluateStockAlertTransition(false, "critical", "increase")).toBeNull();
    expect(evaluateStockAlertTransition(false, "out_of_stock", "increase")).toBeNull();
  });
});
