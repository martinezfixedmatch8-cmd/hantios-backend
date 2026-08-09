import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { getEmailProvider, getEmailProviderName } from "./emailProviderRegistry";
import { resolveSenderAddress, DEFAULT_REPLY_TO } from "./senderProfiles";
import type { SenderProfile } from "./senderProfiles";
import type { Notification } from "./types";

const DEFAULT_SENDER_PROFILE: SenderProfile = "NOREPLY";

// This is "NotificationProvider's email-channel logic" the architecture
// lock describes -- called from ConsoleNotificationProvider.send()
// whenever channel === "email". Resolves the SenderProfile to a real from
// address, applies the default reply-to, calls the registered EmailProvider
// (Resend or Console, selected fail-softly in registry.ts), and records the
// outcome in email_send_log.
//
// Never throws: a failed send must never break the caller's own
// transaction/flow. Every real call site (signup, staff invite, PO
// secure-link generation) invokes this fire-and-forget, after its own DB
// transaction has already committed -- same "DB writes in the transaction,
// I/O after" pattern this repo already established before this session.
//
// Status lifecycle note: the row is created as "queued", then updated to a
// terminal "sent"/"failed" once the (synchronous, in-process) send
// attempt -- including its own internal retry-once, see
// ResendEmailProvider -- has fully resolved. "sending"/"retrying" are real
// EmailStatus values reserved for a future async, queue-based worker
// (Session 7 territory, not built this session) that would poll queued
// rows and transition through them over time; this session's synchronous
// model never has a real observable window in either state, so neither is
// reached here -- an intentional, flagged gap, not an oversight (same
// category as ExpenseWorkflowStatus.draft being reachable-by-schema but
// unreachable-by-code until a real draft-saving flow exists).
export async function sendEmailNotification(notification: Notification): Promise<void> {
  const senderProfile = notification.senderProfile ?? DEFAULT_SENDER_PROFILE;
  const from = resolveSenderAddress(senderProfile);
  const replyTo = notification.replyTo ?? DEFAULT_REPLY_TO;
  const subject = notification.subject ?? "";
  const provider = getEmailProvider();
  const providerName = getEmailProviderName();

  // Generated once, up front -- used both as email_send_log's own primary
  // key AND, unchanged, as the idempotency key passed to the EmailProvider
  // (see SendEmailInput.idempotencyKey). This is what "derived from
  // something stable, not a random value regenerated per attempt" means in
  // practice: one real, persisted identifier representing this specific
  // logical send, reused across ResendEmailProvider's own internal
  // retry-once so a network timeout followed by that retry can never cause
  // Resend to actually transmit the email twice. Generated unconditionally
  // (not only on a successful DB write) so the idempotency guarantee holds
  // even if the email_send_log insert itself fails below.
  const logId = generateId();
  let logCreated = false;
  try {
    await prisma.email_send_log.create({
      data: {
        id: logId,
        business_id: notification.businessId,
        category: notification.category,
        sender_profile: senderProfile,
        to_email: notification.to,
        from_email: from,
        subject,
        status: "queued",
        provider: providerName,
      },
    });
    logCreated = true;
  } catch (err) {
    // A logging failure must never block the actual send attempt below --
    // this table is diagnostic infrastructure, not the source of truth for
    // whether the email itself goes out.
    console.error("[email] failed to write email_send_log (send will still be attempted):", err);
  }

  let result: { success: boolean; providerMessageId?: string; error?: string; attemptCount?: number };
  try {
    result = await provider.sendEmail({
      to: notification.to,
      from,
      subject,
      body: notification.body,
      replyTo,
      attachments: notification.attachments,
      category: notification.category,
      idempotencyKey: logId,
    });
  } catch (err) {
    // Defensive only -- every real EmailProvider implementation already
    // catches its own transport errors internally and returns
    // {success:false, ...} rather than throwing (confirmed directly for
    // ResendEmailProvider; trivially true for ConsoleEmailProvider). This
    // still must never cascade into the caller regardless.
    result = { success: false, error: err instanceof Error ? err.message : "Unknown email send failure", attemptCount: 1 };
  }

  if (!result.success) {
    console.error(`[email] send failed to ${notification.to}: ${result.error ?? "unknown error"}`);
  }

  if (!logCreated) return;

  try {
    const now = new Date();
    await prisma.email_send_log.update({
      where: { id: logId },
      data: result.success
        ? {
            status: "sent",
            provider_message_id: result.providerMessageId,
            attempt_count: result.attemptCount ?? 1,
            last_attempt_at: now,
            sent_at: now,
          }
        : {
            status: "failed",
            failure_reason: result.error,
            attempt_count: result.attemptCount ?? 1,
            last_attempt_at: now,
          },
    });
  } catch (err) {
    console.error("[email] failed to update email_send_log with the final send outcome:", err);
  }
}
