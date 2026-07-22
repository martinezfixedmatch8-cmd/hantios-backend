// General business-timezone utilities -- deliberately not folded into
// receiptNumber.ts, which is its only caller today, so Session 3B's Void/Refund
// day-close comparison (same calendar day in Business.timezone -> Void only;
// later -> Refund only) can reuse this instead of re-deriving timezone math.
export function getBusinessLocalYear(timezone: string, date: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric" }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  if (!year) {
    throw new Error(`Could not resolve year for timezone: ${timezone}`);
  }
  return Number(year);
}
