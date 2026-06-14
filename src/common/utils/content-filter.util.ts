/**
 * Lightweight keyword-based content filter.
 *
 * Apple App Store Guideline 1.2 requires a "method for filtering objectionable
 * content". This blocks the most egregious slurs / sexual / violent terms in
 * user-supplied text (video titles, captions, descriptions, comments) at write
 * time. It is intentionally conservative — anything subtler is handled by the
 * report → admin-review pipeline.
 */

// Base list of banned terms (lowercase, matched as whole words).
const BANNED_TERMS: string[] = [
  // sexual / explicit
  'porn',
  'pornography',
  'xxx',
  'rape',
  'rapist',
  'child porn',
  'cp',
  'pedophile',
  'pedo',
  'molest',
  // hate slurs (representative — extend per policy)
  'nigger',
  'nigga',
  'faggot',
  'retard',
  'kike',
  'spic',
  'chink',
  // violence / self-harm
  'kill yourself',
  'kys',
  'behead',
  'terrorist attack',
];

// Build a single case-insensitive regex with word boundaries.
const BANNED_REGEX = new RegExp(
  '\\b(' +
    BANNED_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
    ')\\b',
  'i',
);

export interface ContentFilterResult {
  clean: boolean;
  matched: string[];
}

/**
 * Scan one or more text fields. Returns the matched banned terms (empty when clean).
 */
export function scanText(...fields: (string | undefined | null)[]): ContentFilterResult {
  const matched = new Set<string>();
  for (const field of fields) {
    if (!field) continue;
    const normalized = field.toLowerCase();
    let m: RegExpExecArray | null;
    const re = new RegExp(BANNED_REGEX.source, 'gi');
    while ((m = re.exec(normalized)) !== null) {
      matched.add(m[1]);
    }
  }
  return { clean: matched.size === 0, matched: Array.from(matched) };
}

export function containsBannedContent(...fields: (string | undefined | null)[]): boolean {
  return !scanText(...fields).clean;
}
