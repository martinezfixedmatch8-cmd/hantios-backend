#!/usr/bin/env node
// Batch 8 Session B (HNT-TEST-001) -- reads tests/quarantine.config.js (the
// single source of truth) and prints a jest --testNamePattern (-t) regex to
// stdout: either the tests to EXCLUDE from the main blocking gate, or the
// tests to run alone in the separate, non-blocking quarantine job.
//
// Usage:
//   node scripts/quarantinePattern.js exclude   # for the main blocking job
//   node scripts/quarantinePattern.js include   # for the quarantine job
//
// Exits non-zero (and prints nothing to stdout) if any entry's expiryDate
// has passed with no renewedUntil covering today -- a quarantined test
// cannot silently stay quarantined forever; this forces a human decision
// (either fix the test, or make an explicit, reviewed renewedUntil edit to
// tests/quarantine.config.js) before CI can even construct its own gate.

const entries = require("../tests/quarantine.config.js");

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isExpired(entry, today) {
  const effectiveExpiry = entry.renewedUntil ? new Date(entry.renewedUntil) : new Date(entry.expiryDate);
  return today > effectiveExpiry;
}

function main() {
  const mode = process.argv[2];
  if (mode !== "include" && mode !== "exclude") {
    console.error("Usage: node scripts/quarantinePattern.js <include|exclude>");
    process.exit(1);
  }

  const today = new Date();
  const expired = entries.filter((e) => isExpired(e, today));
  if (expired.length > 0) {
    console.error("The following quarantine entries have EXPIRED and require an explicit, reviewed renewal (edit tests/quarantine.config.js's own renewedUntil field) or removal before CI can proceed:");
    for (const e of expired) {
      console.error(`  - ${e.id} (issue #${e.issue}, owner ${e.owner}): expired ${e.renewedUntil ?? e.expiryDate} -- ${e.file} > "${e.testNameFragment}"`);
    }
    process.exit(1);
  }

  const escaped = entries.map((e) => escapeRegExp(e.testNameFragment));

  if (mode === "include") {
    // OR of all quarantined names -- matches only these tests, wherever they run.
    process.stdout.write(escaped.join("|"));
  } else {
    // Negative-lookahead chain -- matches every test EXCEPT these.
    process.stdout.write("^(?!.*(?:" + escaped.join(")|.*(?:") + ")).*$");
  }
}

main();
