import type { StorageProvider } from "../../src/storage/StorageProvider";
import type { RegisterUploadInput, RegisteredUpload } from "../../src/storage/types";

export class SpyStorageProvider implements StorageProvider {
  registered: RegisterUploadInput[] = [];

  async registerUpload(input: RegisterUploadInput): Promise<RegisteredUpload> {
    this.registered.push(input);
    return { storageKey: input.clientStorageKey };
  }
}
