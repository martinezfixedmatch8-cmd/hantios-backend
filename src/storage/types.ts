// The client uploads a file elsewhere (today: nowhere real -- this is still
// metadata-only, see StorageProvider.ts's own comment) and tells this
// backend the resulting reference. registerUpload is the one seam every
// caller goes through instead of trusting that reference blindly -- a real
// future implementation (S3/GCS) could validate the key actually exists in
// that backend, rewrite/namespace it, or generate a retrieval URL, without
// any caller's code changing.
export interface RegisterUploadInput {
  businessId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  clientStorageKey: string;
}

export interface RegisteredUpload {
  storageKey: string;
}
