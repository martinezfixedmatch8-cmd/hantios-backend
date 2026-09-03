import { app } from "./app";
import { env } from "./lib/config";
import { startReminderScheduler, runReminderSchedulerCatchUp, stopReminderScheduler } from "./lib/reminderScheduler";
import { startStockAlertSubscriber } from "./lib/stockAlertSubscriber";
import { checkEmailDomainVerification } from "./lib/emailDomainCheck";
import { startPayrollScheduler, runPayrollSchedulerCatchUp, stopPayrollScheduler } from "./lib/payrollScheduler";
import { startReceiptDeliveryRecovery, stopReceiptDeliveryRecovery } from "./lib/receiptDeliveryRecovery";
import { startIdempotencyCleanupScheduler, stopIdempotencyCleanupScheduler } from "./lib/idempotencyCleanupScheduler";
import { startRecurringExpenseScheduler, stopRecurringExpenseScheduler } from "./lib/recurringExpenseScheduler";
import { startRateLimitCleanupScheduler, stopRateLimitCleanupScheduler } from "./lib/rateLimitCleanupScheduler";

// Batch 8 Session A (HNT-OPS-001) -- a bounded grace window for SIGTERM,
// matching Railway's own typical SIGTERM-then-SIGKILL grace period.
// Deliberately does NOT force-release any lease a job currently holds --
// a job mid-safe-cleanup when SIGTERM arrives is left to either finish
// within this window (releasing its own lease normally) or be picked up
// by the next process's own crash-reclaim path once leased_until elapses,
// exactly the same recovery path a hard crash already takes. No second,
// racier shutdown-specific release path is introduced.
const SIGTERM_GRACE_MS = 10_000;

const server = app.listen(env.PORT, () => {
  console.log(`hantios-backend listening on port ${env.PORT} (${env.NODE_ENV})`);
  startReminderScheduler();
  startPayrollScheduler();
  startReceiptDeliveryRecovery();
  startIdempotencyCleanupScheduler();
  startRecurringExpenseScheduler();
  startRateLimitCleanupScheduler();
  startStockAlertSubscriber();
  void checkEmailDomainVerification();

  // Batch 8 Session A -- one immediate catch-up pass at boot for the two
  // discrete-occurrence schedulers, closing a downtime gap promptly
  // instead of waiting for the next natural cron tick (up to 59 minutes
  // for reminders, up to 24 hours for payroll).
  void runReminderSchedulerCatchUp().catch((err) => console.error("[reminderScheduler] boot catch-up failed:", err));
  void runPayrollSchedulerCatchUp().catch((err) => console.error("[payrollScheduler] boot catch-up failed:", err));
});

function shutdown(signal: string): void {
  console.log(`${signal} received -- stopping schedulers, no new jobs will be claimed`);
  stopReminderScheduler();
  stopPayrollScheduler();
  stopReceiptDeliveryRecovery();
  stopIdempotencyCleanupScheduler();
  stopRecurringExpenseScheduler();
  stopRateLimitCleanupScheduler();
  server.close(() => console.log("HTTP server closed"));

  setTimeout(() => {
    console.log(`Grace period (${SIGTERM_GRACE_MS}ms) elapsed -- exiting. Any still-in-flight job's own lease is left for the next process's crash-reclaim path.`);
    process.exit(0);
  }, SIGTERM_GRACE_MS).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
