/**
 * "2026-01-02T03:04:05.678Z" becomes "2026-01-02 03:04 UTC". UTC keeps the
 * display independent of the viewer's time zone (and tests deterministic).
 * Anything that is not a date is returned unchanged.
 */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}
