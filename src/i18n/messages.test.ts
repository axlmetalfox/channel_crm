import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';

// Locale dictionaries are hand-maintained. English is the source of
// truth (src/i18n/request.ts falls back to en.json only when a whole
// locale file is missing — there is no per-key fallback), so a key
// that lands in en.json and not in a translation renders as a raw
// keypath for users on that locale. This guards the parity.

const MESSAGES_DIR = join(process.cwd(), 'messages');
const SOURCE_LOCALE = 'en';
const TRANSLATED_LOCALES = ['ko', 'es'];

function loadKeys(locale: string): Set<string> {
  const raw = readFileSync(join(MESSAGES_DIR, `${locale}.json`), 'utf8');
  const out = new Set<string>();
  const walk = (node: unknown, path: string) => {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) {
        walk(v, path ? `${path}.${k}` : k);
      }
      return;
    }
    out.add(path);
  };
  walk(JSON.parse(raw), '');
  return out;
}

describe('message catalogue parity', () => {
  const source = loadKeys(SOURCE_LOCALE);

  it.each(TRANSLATED_LOCALES)('%s.json covers every en.json key', (locale) => {
    const translated = loadKeys(locale);
    const missing = [...source].filter((k) => !translated.has(k)).sort();
    expect(missing, `${locale}.json is missing these keys`).toEqual([]);
  });

  it.each(TRANSLATED_LOCALES)('%s.json has no orphaned keys', (locale) => {
    const translated = loadKeys(locale);
    const orphaned = [...translated].filter((k) => !source.has(k)).sort();
    expect(orphaned, `${locale}.json has keys absent from en.json`).toEqual([]);
  });
});

// A translation can break the ICU syntax of a string that is fine in
// English (a stray brace, an unbalanced plural). next-intl then renders
// the keypath instead of the text, silently. A string that English parses
// must parse in every translation too.
describe('translations keep valid ICU syntax', () => {
  const leaves = (node: unknown, path = ''): [string, string][] =>
    node && typeof node === 'object'
      ? Object.entries(node).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k))
      : [[path, String(node)]];

  const invalidKeys = (locale: string, messages: unknown): Set<string> => {
    const bad = new Set<string>();
    for (const [key] of leaves(messages)) {
      let code = '';
      const probe = createTranslator({
        locale,
        messages: messages as never,
        onError: (e) => {
          code = e.code;
        },
      });
      probe(key as never);
      if (code === 'INVALID_MESSAGE') bad.add(key);
    }
    return bad;
  };

  const read = (locale: string) =>
    JSON.parse(readFileSync(join(MESSAGES_DIR, `${locale}.json`), 'utf8'));
  const enInvalid = invalidKeys('en', read('en'));

  it.each(TRANSLATED_LOCALES)('%s.json introduces no new unparseable messages', (locale) => {
    const introduced = [...invalidKeys(locale, read(locale))].filter((k) => !enInvalid.has(k));
    expect(introduced).toEqual([]);
  });
});
