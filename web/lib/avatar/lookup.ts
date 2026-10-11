// P2: token -> sign file(s), priority signs/team -> signs/public -> fingerspell via signs/alphabet.
// signs/index.json maps each sign to one file and is where that priority lives (a team capture overwrites the
// entry), so a token found in the index is used as is. FS:WORD and unknown tokens are fingerspelled letter by letter.
import type { SignFile } from "./types";

const SIGNS_URL = "/signs";

let indexPromise: Promise<Record<string, string>> | null = null;
const fileCache = new Map<string, Promise<SignFile | null>>();

export function loadIndex(): Promise<Record<string, string>> {
  if (!indexPromise) {
    indexPromise = fetch(`${SIGNS_URL}/index.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<Record<string, string>>;
      })
      .catch((err) => {
        indexPromise = null; // retried on the next call
        throw err;
      });
  }
  return indexPromise;
}

function isSignFile(value: unknown): value is SignFile {
  const frames = (value as SignFile | null)?.frames;
  return Array.isArray(frames) && frames.length > 0;
}

function loadSign(path: string): Promise<SignFile | null> {
  let file = fileCache.get(path);
  if (!file) {
    file = fetch(`${SIGNS_URL}/${path}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (!isSignFile(json)) throw new Error("no frames");
        return json;
      })
      .catch((err) => {
        console.warn(`[avatar] could not load signs/${path}:`, err);
        fileCache.delete(path);
        return null;
      });
    fileCache.set(path, file);
  }
  return file;
}

async function fingerspell(word: string, index: Record<string, string>): Promise<SignFile[]> {
  const chars = [...word].filter((c) => /[A-Z0-9]/.test(c));
  const files = await Promise.all(
    chars.map((c) => {
      if (index[c]) return loadSign(index[c]);
      console.warn(`[avatar] no sign for letter "${c}", skipped`);
      return null;
    }),
  );
  return files.filter((f): f is SignFile => f !== null);
}

/** Sign files to play for one gloss token, in order. Empty (with a warning) if nothing is found. */
export async function resolveToken(token: string): Promise<SignFile[]> {
  const t = token.trim().toUpperCase();
  let index: Record<string, string>;
  try {
    index = await loadIndex();
  } catch (err) {
    console.warn("[avatar] could not load signs/index.json:", err);
    return [];
  }

  if (!t.startsWith("FS:") && index[t]) {
    const file = await loadSign(index[t]);
    if (file) return [file];
  }

  const word = t.startsWith("FS:") ? t.slice(3) : t;
  if (!t.startsWith("FS:")) console.warn(`[avatar] "${t}" is not in signs/index.json, fingerspelling it`);
  const letters = await fingerspell(word, index);
  if (letters.length === 0) console.warn(`[avatar] nothing to play for "${t}", skipped`);
  return letters;
}
