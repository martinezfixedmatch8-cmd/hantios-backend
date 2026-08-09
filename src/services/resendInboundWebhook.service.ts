import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { generateId } from "../lib/ids";
import { writeAuditLog } from "../lib/auditLog";
import { domainEvents } from "../lib/events";
import { assertNegotiationOpen } from "../lib/poNegotiationGuards";
import { parseReplyToken } from "../lib/inboundEmailCorrelation";
import { extractEmailAddress, extractDisplayName, addressesMatch, sanitizeFilename } from "../lib/emailAddressParsing";
import { getEmailProvider } from "../notifications/registry";
import { getStorageProvider } from "../storage/registry";
import { mimeTypeToAttachmentType, MAX_ATTACHMENT_SIZE_BYTES } from "../validation/poNegotiationAttachment.schema";
import type { ResendInboundEmailReceivedData } from "../validation/resendInboundWebhook.schema";
import type { UnmatchedInboundEmailReason, purchase_orders } from "@prisma/client";

// Same Neon-latency reasoning as every other transactional service in this
// repo. This transaction is deliberately SHORT -- see the "transaction
// boundary" note below -- so the default would likely be fine, but kept
// consistent with every sibling service's own explicit override.
const INBOUND_TRANSACTION_OPTIONS = { timeout: 15000, maxWait: 10000 };

export interface ProcessInboundEmailResult {
  outcome: "already_processed" | "message_created" | "quarantined";
  messageId?: string;
  unmatchedEmailId?: string;
  reason?: UnmatchedInboundEmailReason;
}

// ---------------------------------------------------------------------------
// TRANSACTION BOUNDARY (Lock #9), documented precisely, not just asserted:
//
// Everything before the final $transaction call below (checking for an
// existing claim, resolving a PO by correlation token, verifying the
// sender, fetching the full email body via a real Resend API call,
// validating attachment metadata) is PURE READ WORK with zero side
// effects -- safe to redo in full on any crash or webhook redelivery,
// since re-running it produces the identical result from the identical
// (already-delivered, immutable) inbound email. This is a deliberate
// design choice, not an oversight: holding a DB transaction open across a
// real external HTTP call (the Resend API fetch) for however long that
// call takes would be a genuine anti-pattern (unpredictable lock duration,
// connection-pool exhaustion risk) -- the exact same class of concern this
// repo's own SALE_TRANSACTION_OPTIONS-style timeout tuning already exists
// to manage for pure-DB latency, made worse by unbounded network latency.
//
// The actual atomic unit -- claim + po_negotiation_messages (+ its
// attachments) + audit_logs, or claim + unmatched_inbound_emails -- is the
// single $transaction below. The claim (resend_inbound_claims, a real
// @unique DB constraint) is the FIRST write inside that same transaction,
// not a separate earlier one: if two deliveries of the same resend_email_id
// reach this point concurrently, exactly one transaction's claim insert
// succeeds and commits its own message/quarantine row atomically with it;
// the other's claim insert hits the unique constraint, its whole
// transaction rolls back (including any message it might otherwise have
// written), and it's treated as an idempotent no-op. This is what makes
// Lock #5's "two concurrent webhook requests... exactly ONE negotiation
// message" a real, database-enforced guarantee, not an in-memory one.
//
// Residual window: if the process crashes AFTER this transaction commits
// but BEFORE the 200 response reaches Resend, Resend will legitimately
// redeliver -- the redelivery's claim insert then correctly no-ops against
// the already-committed row. There is no window where a claim can exist
// without its message/quarantine row, or vice versa, by construction.
// ---------------------------------------------------------------------------
export async function processResendInboundEmail(data: ResendInboundEmailReceivedData): Promise<ProcessInboundEmailResult> {
  // Optimization only, not the authoritative check (see above) -- avoids a
  // wasted Resend API call on an obvious redelivery.
  const existingClaim = await prisma.resend_inbound_claims.findUnique({ where: { resend_email_id: data.email_id } });
  if (existingClaim) {
    return { outcome: "already_processed" };
  }

  const fromAddress = extractEmailAddress(data.from);
  const senderDisplayName = extractDisplayName(data.from);

  // Lock #2: thread matching, tier 1 ONLY -- a deterministic, per-PO,
  // @unique correlation token embedded in the outbound email's own
  // dedicated reply-to address (see inboundEmailCorrelation.ts and Lock #7's
  // own write-up in CLAUDE.md for why subject/quoted-body/threading-headers
  // were all rejected as unreliable). Every address in `to` is checked
  // (an inbound email can legitimately be addressed to more than one
  // recipient); a real @unique DB constraint on negotiation_reply_token
  // makes "ambiguous match" structurally impossible for this tier -- it
  // either resolves to exactly one PO or it doesn't resolve at all.
  let matchedPo: purchase_orders | null = null;
  for (const toAddress of data.to) {
    const token = parseReplyToken(toAddress);
    if (!token) continue;
    const candidate = await prisma.purchase_orders.findUnique({ where: { negotiation_reply_token: token } });
    if (candidate) {
      matchedPo = candidate;
      break;
    }
  }

  if (!matchedPo) {
    return quarantine(data, "thread_not_found", null, fromAddress);
  }

  // Lock #1: everything downstream is scoped to matchedPo.business_id --
  // the ONLY source of tenant identity this flow ever trusts, resolved
  // exclusively via the @unique correlation token above, never from the
  // sender's own claimed email address or any other client-suppliable value.
  const businessId = matchedPo.business_id;

  // The negotiation must still genuinely be open (same guard every owner/
  // supplier-portal write path already uses) -- a reply arriving after the
  // PO left "sent" status (or after GRN receiving started) has nowhere
  // legitimate to land. Treated as thread_not_found, not a 400 -- this is a
  // webhook, not a user-facing request that can be told to fix its input.
  try {
    await assertNegotiationOpen(matchedPo);
  } catch {
    return quarantine(data, "thread_not_found", businessId, fromAddress);
  }

  // Lock #3: sender identity verification. The matched PO's OWN
  // supplier_email_snapshot (the policy-snapshot value captured when the
  // negotiation began, per this module's existing precedent -- see
  // poSecureLink.service.ts's own identical reasoning) is the sole
  // authority here, never a live suppliers.email lookup and never "any
  // known supplier anywhere" -- a from-address matching a DIFFERENT
  // supplier (same or another business) is exactly as rejected as a
  // totally unknown address; both are indistinguishable "not the supplier
  // on THIS PO" cases and both quarantine with the same reason, matching
  // the locked 4-value reason enum (no extra granularity invented).
  if (!matchedPo.supplier_email_snapshot || !addressesMatch(fromAddress, matchedPo.supplier_email_snapshot)) {
    return quarantine(data, "sender_not_recognized", businessId, fromAddress);
  }

  // Fetch the full body + attachment metadata -- the webhook payload alone
  // never carries either (confirmed directly from Resend's own SDK type
  // defs during Phase 0). A null result (provider capability missing, or
  // the API call itself failed) is treated as unparseable, not a crash.
  const provider = getEmailProvider();
  const fullEmail = provider.getReceivedEmail ? await provider.getReceivedEmail(data.email_id) : null;
  if (!fullEmail) {
    return quarantine(data, "parse_error", businessId, fromAddress);
  }

  // Lock #4: validate attachment metadata against the SAME limits
  // po_negotiation_attachments' own schema already enforces (10MB, a fixed
  // MIME allowlist) -- never a second, potentially-drifting limit. An
  // individual invalid attachment is skipped and logged, never a reason to
  // fail the whole message (the reply text itself is still real, legitimate
  // content worth ingesting).
  const validAttachments: { id: string; fileName: string; mimeType: string; sizeBytes: number }[] = [];
  for (const attachment of fullEmail.attachments) {
    if (attachment.sizeBytes <= 0 || attachment.sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) {
      console.warn(`[inbound-email] skipping oversized/invalid-size attachment on email ${data.email_id}: ${attachment.sizeBytes} bytes`);
      continue;
    }
    if (!mimeTypeToAttachmentType(attachment.mimeType)) {
      console.warn(`[inbound-email] skipping unsupported attachment type on email ${data.email_id}: ${attachment.mimeType}`);
      continue;
    }
    validAttachments.push({
      id: attachment.id,
      fileName: sanitizeFilename(attachment.filename),
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    });
  }

  const messageText = fullEmail.text && fullEmail.text.trim().length > 0 ? fullEmail.text : "(no text content)";
  const senderName = senderDisplayName ?? fromAddress;

  try {
    const message = await prisma.$transaction(async (tx) => {
      // The single atomic claim -- see the transaction-boundary note above.
      await tx.resend_inbound_claims.create({ data: { id: generateId(), resend_email_id: data.email_id } });

      const created = await tx.po_negotiation_messages.create({
        data: {
          id: generateId(),
          business_id: businessId,
          purchase_order_id: matchedPo.id,
          sender_type: "supplier",
          sender_name: senderName,
          message_text: messageText,
          source: "email",
          resend_email_id: data.email_id,
        },
      });

      for (const attachment of validAttachments) {
        // Same metadata-only StorageProvider convention every other
        // attachment feature in this repo already uses (Expense/PO
        // Negotiation/Shipment attachments never touch real bytes) -- the
        // storage key is a stable reference back to Resend's own hosted
        // copy, built exclusively from Resend's own opaque ids, never from
        // the (untrusted, sanitized-for-display-only) filename.
        const registered = await getStorageProvider().registerUpload({
          businessId,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          clientStorageKey: `resend-inbound:${data.email_id}:${attachment.id}`,
        });

        await tx.po_negotiation_attachments.create({
          data: {
            id: generateId(),
            business_id: businessId,
            purchase_order_id: matchedPo.id,
            message_id: created.id,
            type: mimeTypeToAttachmentType(attachment.mimeType)!,
            file_name: attachment.fileName,
            file_size_bytes: attachment.sizeBytes,
            storage_key: registered.storageKey,
            uploaded_by: "supplier",
            uploaded_by_name: senderName,
          },
        });
      }

      await writeAuditLog(tx, {
        businessId,
        userId: matchedPo.created_by,
        userName: `Supplier (email): ${senderName} <${fromAddress}>`,
        userRole: "supplier",
        action: "purchase_order.negotiation_email_received",
        entityType: "po_negotiation_message",
        entityId: created.id,
        reason: `Inbound email reply ingested on PO ${matchedPo.po_number} (Resend email ${data.email_id})`,
      });

      return created;
    }, INBOUND_TRANSACTION_OPTIONS);

    domainEvents.publish("PurchaseOrderNegotiationEmailReceived", {
      businessId,
      purchaseOrderId: matchedPo.id,
      messageId: message.id,
      resendEmailId: data.email_id,
    });

    return { outcome: "message_created", messageId: message.id };
  } catch (err) {
    // A concurrent delivery of the same resend_email_id won this race --
    // its transaction already committed the message/quarantine row.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { outcome: "already_processed" };
    }
    throw err;
  }
}

async function quarantine(
  data: ResendInboundEmailReceivedData,
  reason: UnmatchedInboundEmailReason,
  businessId: string | null,
  fromAddress: string
): Promise<ProcessInboundEmailResult> {
  try {
    const row = await prisma.$transaction(async (tx) => {
      // Same atomic claim, same transaction-boundary reasoning as the
      // success path above -- a quarantine outcome is claimed exactly the
      // same way a message-creation outcome is, through the identical
      // resend_inbound_claims @unique gate.
      await tx.resend_inbound_claims.create({ data: { id: generateId(), resend_email_id: data.email_id } });

      const created = await tx.unmatched_inbound_emails.create({
        data: {
          id: generateId(),
          resend_email_id: data.email_id,
          from_address: fromAddress,
          to_address: data.to[0] ?? "",
          subject: data.subject || null,
          // Always null this session -- every quarantine path (thread not
          // found, sender not recognized, or the body-fetch itself
          // failing) is reached BEFORE any real body content is ever
          // available, so there is genuinely nothing safe to preview yet.
          // Kept as a real column for a future session where a quarantine
          // path exists that DOES have verified content on hand.
          body_preview: null,
          reason,
          business_id: businessId,
        },
      });
      return created;
    }, INBOUND_TRANSACTION_OPTIONS);

    domainEvents.publish("PurchaseOrderNegotiationEmailUnmatched", {
      businessId,
      resendEmailId: data.email_id,
      reason,
    });

    return { outcome: "quarantined", unmatchedEmailId: row.id, reason };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { outcome: "already_processed" };
    }
    throw err;
  }
}
