// Batch 8 Session B (HNT-TEST-001) -- the single source of truth for which
// tests are quarantined from the blocking CI gate. Never a bare `.skip()`
// or a broad `testPathIgnorePatterns` entry: every quarantined test is
// named here explicitly, linked to a real tracked issue, with an owner and
// an expiry date. scripts/quarantinePattern.js reads this file to build
// both the main (exclude these) and quarantine-job (include only these)
// jest -t regexes, so there is exactly one place this list can drift out
// of date.
//
// A test cannot remain quarantined past its expiryDate without a
// documented, explicit renewal -- scripts/quarantinePattern.js refuses to
// run (non-zero exit, listing every expired entry) once `expiryDate` has
// passed, unless `renewedUntil` has been set to a new, later date by a
// human editing this file directly (a real diff reviewed on its own merits,
// never a silent auto-extension).
//
// Root cause for issues #6-#9: real, environment-level Neon/HTTP latency
// combined with a test design that performs many sequential round trips
// inside a fixed timeout -- confirmed via direct isolated reproduction
// during Batch 8 Session A's own full-suite verification (not a Batch 8
// code defect; none of these tests exercise any Batch 8 Session A/B code).
//
// Issue #13 is a genuinely different, not-yet-proven class: a real,
// reproducible correlation with ephemeral/fresh-branch provisioning (3/3
// CI failures vs. a clean same-session local run against a long-lived
// branch), but direct tracing of the service's own transaction/lock logic
// found no constructible path to the observed failure -- the mechanism
// itself remains unconfirmed. Quarantined rather than fixed speculatively,
// since this is core financial/data-integrity logic (supplier default-
// payment-instruction uniqueness). See issue #13 for the full investigation.

/**
 * @typedef {Object} QuarantineEntry
 * @property {string} id
 * @property {string} file
 * @property {string} testNameFragment - substring of the full `describe > it` name, unique enough to match only this one test
 * @property {number} issue - GitHub issue number
 * @property {string} owner
 * @property {string} expiryDate - YYYY-MM-DD
 * @property {string} [renewedUntil] - YYYY-MM-DD, only set on an explicit, reviewed renewal
 * @property {string} reason
 */

/** @type {QuarantineEntry[]} */
module.exports = [
  {
    id: "HNT-FLAKY-006",
    file: "tests/debt.test.ts",
    testNameFragment: "computes a percentage/monthly/simple charge against remaining balance, writes an immutable debt_transactions row, updates the balance, and publishes InterestApplied",
    issue: 6,
    owner: "martinezfixedmatch8-cmd",
    expiryDate: "2026-11-25",
    reason: "date-fns differenceInCalendarMonths calendar-boundary sensitivity, real-clock dependent -- long-documented across multiple prior remediation batches, not a code defect.",
  },
  {
    id: "HNT-FLAKY-007",
    file: "tests/debt.test.ts",
    testNameFragment: "computes daily periods_elapsed from the business's own calendar day, independent of last_interest_applied_at's stored wall-clock hour (regression: server-local-timezone leak)",
    issue: 7,
    owner: "martinezfixedmatch8-cmd",
    expiryDate: "2026-11-25",
    reason: "Samples up to 6 wall-clock hour candidates, each doing a full HTTP-create + Prisma-update/read + HTTP apply-interest round trip inside a fixed 30s timeout -- confirmed reproducing identically in complete isolation during Batch 8 Session A verification, root-caused to real per-query Neon latency, not a Batch 8 code path.",
  },
  {
    id: "HNT-FLAKY-008",
    file: "tests/poCommercialInvoice.test.ts",
    testNameFragment: "201s once the shipment reaches IN_TRANSIT/ARRIVED/DELIVERED too, not only DISPATCHED",
    issue: 8,
    owner: "martinezfixedmatch8-cmd",
    expiryDate: "2026-11-25",
    reason: "createShippedPo() called 3x in a loop, each walking the full shipment state machine -- confirmed reproducing identically in complete isolation during Batch 8 Session A verification; not a Batch 8 code path (Session A touches only idempotency call-site plumbing, which is net cheaper per call, never slower).",
  },
  {
    id: "HNT-FLAKY-009",
    file: "tests/poShipment.test.ts",
    testNameFragment: "accepts all 11 real Incoterm values",
    issue: 9,
    owner: "martinezfixedmatch8-cmd",
    expiryDate: "2026-11-25",
    reason: "11-Incoterm loop, each iteration a full PO-create+send+shipment-create cycle (44+ round trips) -- confirmed reproducing identically in complete isolation during Batch 8 Session A verification. Three sibling failures observed in the same file/describe block during a combined full-suite run (a cascading P2028 transaction-timeout and its resulting TypeError, plus one more timeout) did NOT reproduce in isolation and are not quarantined here -- confirmed combined-run resource-pressure artifacts, a different, non-deterministic class.",
  },
  {
    id: "HNT-FLAKY-013",
    file: "tests/supplierPaymentInstruction.test.ts",
    testNameFragment: "only one row is ever default at a time, even under concurrent set-default calls targeting different instructions",
    issue: 13,
    owner: "martinezfixedmatch8-cmd",
    expiryDate: "2026-11-27",
    reason: "Failed identically (409 instead of 200) on 3 of 3 Batch 8 Session B CI runs against freshly-created ephemeral Neon branches, while passing cleanly the same session against the long-lived local test branch. Direct tracing of the service's own transaction/lock logic against the real partial-unique-index constraint found no constructible logic path to this failure for two calls targeting different rows -- correlation with fresh-branch provisioning is established, the underlying mechanism is not yet proven. See issue #13 for the full investigation.",
  },
];
