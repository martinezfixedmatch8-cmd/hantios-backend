import type { StorageProvider } from "./StorageProvider";
import type { RegisterUploadInput, RegisteredUpload } from "./types";
import { env } from "../lib/config";

// Stub provider: no real file-byte storage exists anywhere in this repo yet
// (no S3/GCS integration, no multipart upload endpoint) -- this mirrors
// Expense Attachments' own pre-existing, confirmed-metadata-only behavior
// exactly. registerUpload is a pure pass-through: the client-supplied key is
// returned unchanged, never validated against a real backend. A future real
// implementation slots in behind this same interface without any caller
// (Expense Attachments, PO Negotiation Attachments) needing to change.
export class ConsoleStorageProvider implements StorageProvider {
  async registerUpload(input: RegisterUploadInput): Promise<RegisteredUpload> {
    if (env.NODE_ENV !== "production") {
      console.log(`[storage] registered upload for business ${input.businessId}: ${input.fileName} (${input.mimeType}, ${input.sizeBytes} bytes) -> ${input.clientStorageKey}`);
    }
    return { storageKey: input.clientStorageKey };
  }
}
