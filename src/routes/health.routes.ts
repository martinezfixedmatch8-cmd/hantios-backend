import { Router } from "express";
import { prisma } from "../lib/prisma";

// Batch 8 Session B (HNT-OBS-001). Confirmed absent before this session via
// direct grep of src/app.ts and src/routes/ -- not assumed.
//
// /health is pure liveness -- the process is up, nothing more. No
// dependency check, no DB call, so a database outage never makes the
// process itself report unhealthy (that's exactly what /ready is for).
//
// /ready checks the one real dependency this app has (the database) via a
// short-timeout, read-only SELECT 1. A hanging connection is bounded by
// READY_CHECK_TIMEOUT_MS rather than left to hang the health probe
// indefinitely.
//
// Neither response ever includes anything beyond a bare status string and
// the request id -- no stack trace, no connection string, no provider
// detail, no environment values, no build secrets. The caught branch in
// /ready deliberately discards the actual error object; only the fact of
// failure (not its content) is ever surfaced.
const router = Router();

const READY_CHECK_TIMEOUT_MS = 3000;

router.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", requestId: req.requestId });
});

router.get("/ready", async (req, res) => {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("ready check timed out")), READY_CHECK_TIMEOUT_MS);
      }),
    ]);
    res.status(200).json({ status: "ready", requestId: req.requestId });
  } catch {
    res.status(503).json({ status: "not_ready", requestId: req.requestId });
  }
});

export default router;
