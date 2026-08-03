import type { RegisterUploadInput, RegisteredUpload } from "./types";

export interface StorageProvider {
  registerUpload(input: RegisterUploadInput): Promise<RegisteredUpload>;
}
