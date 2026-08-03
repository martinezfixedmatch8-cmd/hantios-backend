import type { StorageProvider } from "./StorageProvider";
import { ConsoleStorageProvider } from "./ConsoleStorageProvider";

let provider: StorageProvider = new ConsoleStorageProvider();

export function getStorageProvider(): StorageProvider {
  return provider;
}

// Dependency-injection seam so tests can swap in a spy/mock instead of
// depending on console output to assert an upload was registered.
export function setStorageProvider(next: StorageProvider): void {
  provider = next;
}
