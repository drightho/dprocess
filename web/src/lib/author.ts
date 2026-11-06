import { browserStorage, type Store } from "./recent";

/** Where the name used for comments is remembered (per browser, like the recent-projects list). */
export const AUTHOR_KEY = "dprocess.author";

/** The author name last used for a comment, or "" (nothing saved, or storage unavailable). */
export function readAuthor(store: Store | null = browserStorage()): string {
  if (!store) return "";
  try {
    return store.getItem(AUTHOR_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Remembers the author name for next time. Never throws. */
export function saveAuthor(name: string, store: Store | null = browserStorage()): void {
  if (!store) return;
  try {
    store.setItem(AUTHOR_KEY, name);
  } catch {
    // Blocked or full storage: remembering the name is only a convenience.
  }
}
