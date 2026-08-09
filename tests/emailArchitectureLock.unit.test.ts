import * as fs from "fs";
import * as path from "path";

// Module 33 Session 4A -- ARCHITECTURE LOCK enforcement. `import { Resend }`
// (or any other form of importing the "resend" package) must appear in
// exactly one file in this codebase: src/notifications/ResendEmailProvider.ts.
// Every other file -- including NotificationProvider's own email-channel
// logic -- must talk to the EmailProvider interface only. This test is the
// automated guard against that regressing silently later (e.g. someone
// "quickly" importing Resend directly in a service for a one-off send).
const SRC_ROOT = path.join(__dirname, "..", "src");
const ALLOWED_FILE = path.join("src", "notifications", "ResendEmailProvider.ts");

// Matches `from "resend"`, `from 'resend'`, and `require("resend")` /
// `require('resend')` -- covers both ESM-style and CJS-style import
// syntax, since ts-node/tsc output and any future refactor could use either.
const RESEND_IMPORT_PATTERN = /(?:from\s+["']resend["'])|(?:require\(\s*["']resend["']\s*\))/;

function listTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("Architecture Lock -- Resend SDK import location", () => {
  it("imports { Resend } (or requires \"resend\") in exactly one file: src/notifications/ResendEmailProvider.ts", () => {
    const files = listTsFiles(SRC_ROOT);
    const offenders: string[] = [];

    for (const file of files) {
      const relativePath = path.relative(path.join(__dirname, ".."), file);
      const content = fs.readFileSync(file, "utf8");
      if (RESEND_IMPORT_PATTERN.test(content)) {
        offenders.push(relativePath);
      }
    }

    expect(offenders).toEqual([ALLOWED_FILE]);
  });

  it("the allowed file actually imports Resend (sanity check -- the test above isn't vacuously passing)", () => {
    const content = fs.readFileSync(path.join(__dirname, "..", ALLOWED_FILE), "utf8");
    expect(RESEND_IMPORT_PATTERN.test(content)).toBe(true);
  });
});
