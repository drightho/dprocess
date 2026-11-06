/** Stories above this many lines get a warning (the server never rejects them). */
export const MAX_STORY_LOC = 400;

export type Estimate = { ok: true; value: number | null } | { ok: false; message: string };

/**
 * Reads the estimate field: empty means "no estimate" (null), otherwise a whole
 * number of lines. Negative numbers are left to the server to refuse.
 */
export function parseEstimate(text: string): Estimate {
  const t = text.trim();
  if (t === "") return { ok: true, value: null };
  if (!/^-?\d+$/.test(t)) return { ok: false, message: "The estimate must be a whole number of lines." };
  const value = Number(t);
  if (!Number.isSafeInteger(value)) return { ok: false, message: "The estimate is too large." };
  return { ok: true, value };
}

/** Whether the typed estimate exceeds the recommended size (shown as a live warning). */
export function overLimit(text: string): boolean {
  const e = parseEstimate(text);
  return e.ok && e.value !== null && e.value > MAX_STORY_LOC;
}
