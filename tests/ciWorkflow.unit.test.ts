import * as fs from "fs";
import * as path from "path";

interface QuarantineEntry {
  id: string;
  file: string;
  testNameFragment: string;
  issue: number;
  owner: string;
  expiryDate: string;
  renewedUntil?: string;
  reason: string;
}

// quarantine.config.js is a plain CommonJS file with no declaration file --
// require() (rather than a static `import`, which TS can't type without one)
// is the correct, narrow tool here, not a style preference.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const quarantineEntries = require("./quarantine.config.js") as QuarantineEntry[];

// Batch 8 Session B (HNT-TEST-001) -- static checks against the actual
// committed workflow file's own text, proving the required security
// properties rather than asserting them by code review alone. Plain
// string/regex inspection rather than a YAML-parsing library: js-yaml is
// only a transitive dependency here (pulled in by eslint's own toolchain,
// not declared in package.json), too fragile a thing to depend on directly
// from a committed test for a check this simple to do without it.
describe("CI workflow -- static security properties", () => {
  const workflowPath = path.join(__dirname, "..", ".github", "workflows", "ci.yml");
  const workflow = fs.readFileSync(workflowPath, "utf8");

  it("triggers on pull_request", () => {
    expect(workflow).toMatch(/^on:\s*\n\s*pull_request:/m);
  });

  it("never uses pull_request_target anywhere in the file", () => {
    expect(workflow).not.toContain("pull_request_target");
  });

  it("never references a secret named DATABASE_URL (the production secret) anywhere", () => {
    expect(workflow).not.toMatch(/secrets\.DATABASE_URL\b/);
  });

  // A real top-level job key is a line indented by EXACTLY 2 spaces
  // followed by a non-space character (the job id) then a colon --
  // distinct from any job-property line (4+ spaces) or mid-line text.
  // getJobBody finds one such job's own name line and slices up to
  // (but not including) the NEXT one, giving that job's full body.
  function getJobBody(jobId: string): string {
    const jobHeaderRe = /\n {2}(\S[^\n:]*):/g;
    const headers: { name: string; index: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = jobHeaderRe.exec(workflow)) !== null) {
      headers.push({ name: m[1], index: m.index });
    }
    const i = headers.findIndex((h) => h.name === jobId);
    expect(i).toBeGreaterThan(-1); // fails loudly if the job id doesn't exist at all
    const start = headers[i].index;
    const end = i + 1 < headers.length ? headers[i + 1].index : workflow.length;
    return workflow.slice(start, end);
  }

  it("the fork-safe `checks` job has no `if:` restriction and references no secrets", () => {
    const checksJobBody = getJobBody("checks");
    expect(checksJobBody).not.toMatch(/^\s*if:/m);
    expect(checksJobBody).not.toMatch(/secrets\./);
  });

  it("the database-touching jobs (provision-db, db-integration-tests, quarantine-tests) are all gated to same-repository PRs only", () => {
    const sameRepoGate = "github.event.pull_request.head.repo.full_name == github.repository";
    for (const job of ["provision-db", "db-integration-tests", "quarantine-tests"]) {
      expect(getJobBody(job)).toContain(sameRepoGate);
    }
  });

  it("the quarantine-tests job is non-blocking (continue-on-error: true at the job level)", () => {
    expect(getJobBody("quarantine-tests")).toMatch(/continue-on-error:\s*true/);
  });

  it("cleanup runs under if: always() and is scoped to whether provision-db actually created a branch, not the job's own overall result", () => {
    // Branch creation and warm-up are separate steps within provision-db --
    // a branch created successfully by the first step must still be
    // deleted even when a later step (warm-up) fails and makes the whole
    // job's own result "failure". Gating on the job's overall result
    // (the original, since-fixed condition) skipped cleanup in exactly
    // that case, orphaning a real, billable Neon branch.
    expect(getJobBody("cleanup-db")).toMatch(/if:\s*always\(\)\s*&&\s*needs\.provision-db\.outputs\.branch_id\s*!=\s*''/);
  });

  it("cleanup deletes by the exact stored branch_id output, never a name search or list call", () => {
    const jobBody = getJobBody("cleanup-db");
    expect(jobBody).toContain("needs.provision-db.outputs.branch_id");
    expect(jobBody).toMatch(/branches\/\$\{BRANCH_ID\}/);
    // No branch-listing endpoint anywhere in the cleanup job.
    expect(jobBody).not.toMatch(/GET.*\/branches"/);
  });

  it("branch creation uses the exact confirmed Neon API endpoint and never guesses a different one", () => {
    expect(workflow).toContain("https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches");
  });

  it("the workflow's own comments reference all five quarantined issues", () => {
    expect(workflow).toMatch(/#6-#9, #13/);
  });

  it("branch creation reads the direct (non-pooled) host from endpoints, never connection_uris or pooler_host", () => {
    // HNT-CI-DNS-001: connection_uris is documented by Neon as omitted
    // from the branch-creation response whenever the parent branch has
    // more than one role or database -- confirmed as the real root
    // cause of a whole DNS investigation (jq's own null-propagation
    // silently turned the missing path into the literal string "null").
    // endpoints[].host is the confirmed-reliable, always-populated
    // replacement; pooler_host is Neon's own deprecated field.
    expect(workflow).toContain("endpoints[0].host");
    expect(workflow).not.toContain("connection_uris");
    expect(workflow).not.toContain("pooler_host");
  });
});

describe("Quarantine config -- referential integrity with CI", () => {
  it("every quarantine entry references one of the five confirmed issues (#6-#9, #13), each exactly once", () => {
    const issues = quarantineEntries.map((e) => e.issue).sort((a, b) => a - b);
    expect(issues).toEqual([6, 7, 8, 9, 13]);
  });

  it("every quarantine entry has a non-empty owner and a well-formed expiryDate", () => {
    for (const e of quarantineEntries) {
      expect(e.owner.length).toBeGreaterThan(0);
      expect(e.expiryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
