// Module 33 Session 4B -- small, reusable helpers for parsing raw RFC 5322
// address strings ("Display Name <addr@domain.com>" or a bare address)
// coming from untrusted inbound webhook payloads. Deliberately simple
// (regex-based, not a full RFC 5322 parser) -- matches
// ResendEmailProvider's own extractDomain helper's exact scope, since
// that's the only precedent for this kind of parsing already in this repo.

const DISPLAY_NAME_PATTERN = /^\s*(.*?)\s*<([^<>]+)>\s*$/;

// "Ahmed Hassan <ahmed@supplier.test>" -> "ahmed@supplier.test"
// "ahmed@supplier.test" -> "ahmed@supplier.test"
export function extractEmailAddress(rawFrom: string): string {
  const match = rawFrom.match(DISPLAY_NAME_PATTERN);
  return (match ? match[2] : rawFrom).trim();
}

// "Ahmed Hassan <ahmed@supplier.test>" -> "Ahmed Hassan"
// "ahmed@supplier.test" -> null (no display name present)
export function extractDisplayName(rawFrom: string): string | null {
  const match = rawFrom.match(DISPLAY_NAME_PATTERN);
  if (!match) return null;
  const name = match[1].replace(/^["']|["']$/g, "").trim();
  return name.length > 0 ? name : null;
}

// Case-insensitive, trimmed comparison -- email addresses are conventionally
// treated case-insensitively in practice (domain part always is per RFC;
// local-part sensitivity is implementation-defined but no real mail
// provider actually enforces it), matching how every other email-address
// comparison in this repo already normalizes (e.g. users.email lookups).
export function addressesMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// Lock #4 -- sanitize filenames defensively even though storage_key is
// always independently generated from Resend's own opaque attachment id
// (never derived from the filename, so path traversal via storage_key is
// structurally impossible already). file_name is still stored for display
// purposes, so untrusted control characters/path separators/traversal
// sequences/excessive length are stripped here regardless. Also strips bare
// ".." sequences, not just "/"/"\\" separators -- a filename like
// "../../../etc/passwd.pdf" must not merely become ".._.._.._etc_passwd.pdf"
// (separators neutralized but the literal ".." left intact), confirmed by
// a real test failure caught during this session's own verification before
// this fix, not a hypothetical.
export function sanitizeFilename(rawFilename: string | null): string {
  const fallback = "attachment";
  if (!rawFilename) return fallback;
  const noSeparators = rawFilename.split("/").join("_").split("\\").join("_");
  const noTraversal = noSeparators.split("..").join("_");
  const noControlChars = noTraversal.replace(/[\x00-\x1f\x7f]/g, "");
  const stripped = noControlChars.trim();
  if (stripped.length === 0) return fallback;
  return stripped.slice(0, 255);
}
