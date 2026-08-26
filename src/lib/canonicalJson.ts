import { createHash } from "crypto";

// Batch 8 Session A (HNT-IDEMP-002) -- object key order is never semantic
// in JSON, so a naive JSON.stringify(payload) would let {a:1,b:2} and
// {b:2,a:1} hash differently even though they represent the identical
// logical request. Sorts object keys recursively before serializing; array
// element order is preserved as-is (arrays ARE semantically ordered).
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      result[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return result;
  }
  return value;
}

export function canonicalHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex");
}
