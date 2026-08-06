#!/usr/bin/env node
// Fires on the Claude Code Stop hook. Posts to Slack only when HEAD has moved
// past the last commit this script already notified about, so it's a no-op
// on every ordinary turn and only fires once per real commit.
// Live-verified 2026-08-06: fired correctly on this exact commit.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");

function run(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, encoding: "utf8" }).trim();
  } catch (e) {
    return "";
  }
}

const toplevel = run("git rev-parse --show-toplevel", process.cwd());
if (!toplevel) process.exit(0);

const markerPath = path.join(toplevel, ".claude", ".last-notified-commit");
const head = run("git rev-parse HEAD", toplevel);
if (!head) process.exit(0);

let last = "";
try {
  last = fs.readFileSync(markerPath, "utf8").trim();
} catch (e) {}

if (head === last) process.exit(0);

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  // No token configured on this machine - record the marker so we don't
  // silently accumulate a backlog, but skip posting.
  fs.writeFileSync(markerPath, head);
  process.exit(0);
}

const subject = run(`git log -1 --pretty=format:%s ${head}`, toplevel);
const body = run(`git log -1 --pretty=format:%b ${head}`, toplevel);
const repoName = path.basename(toplevel);

let text = `:hammer_and_wrench: New commit pushed to \`${repoName}\`: *${subject}*`;
if (body) text += `\n${body}`;

function post(channel) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ channel, text });
    const req = https.request(
      {
        hostname: "slack.com",
        path: "/api/chat.postMessage",
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => resolve(raw));
      }
    );
    req.on("error", () => resolve(null));
    req.write(data);
    req.end();
  });
}

// #engineering, #reports
Promise.all([post("C0BMXGVT7B8"), post("C0BMWFNV5NZ")]).then(() => {
  fs.writeFileSync(markerPath, head);
});
