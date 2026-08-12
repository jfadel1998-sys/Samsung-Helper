import { convert } from 'html-to-text';

/**
 * HTML -> readable plaintext, then trimmed to a cap.
 *
 * Quoted reply chains and signature blocks are cut: on a long thread they are
 * most of the payload, they repeat content we already ingested as its own
 * event, and every character of them is a character of extraction budget (§7.2
 * truncates bodies to 1500 chars).
 */
export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'blockquote', format: 'skip' },
      { selector: 'table', options: { uppercaseHeaderCells: false } },
    ],
  });
}

const QUOTE_MARKERS = [
  /^\s*-{2,}\s*Original Message\s*-{2,}/im,
  /^\s*_{5,}\s*$/m,
  /^\s*From:\s.+\n\s*Sent:\s/im,
  /^\s*On .{3,80}\bwrote:\s*$/im,
  /^\s*>{1,}\s/m,
];

const SIGNATURE_MARKER = /^\s*--\s*$/m;

export function stripQuotedReply(text: string): string {
  let cut = text.length;
  for (const re of QUOTE_MARKERS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  const sig = SIGNATURE_MARKER.exec(text);
  // Only treat "--" as a signature cut if it isn't the very top of the message.
  if (sig && sig.index > 40 && sig.index < cut) cut = sig.index;
  return text.slice(0, cut);
}

/** Collapses runs of whitespace and blank lines without gluing words together. */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function toBodyExcerpt(
  input: { html?: string | null; text?: string | null },
  maxChars = 4000,
): string {
  const raw = input.text?.trim()
    ? input.text
    : input.html
      ? htmlToText(input.html)
      : '';
  const cleaned = normalizeWhitespace(stripQuotedReply(raw));
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;
}

/** `"Nickolas, T." <t.nick@example.com>` -> name + address. */
export function parseAddress(input: string | null | undefined): {
  name: string | null;
  address: string | null;
} {
  if (!input) return { name: null, address: null };
  const angled = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(input);
  if (angled) {
    const name = angled[1]!.replace(/^["']|["']$/g, '').trim();
    return { name: name || null, address: angled[2]!.trim().toLowerCase() };
  }
  const trimmed = input.trim();
  return trimmed.includes('@')
    ? { name: null, address: trimmed.toLowerCase() }
    : { name: trimmed || null, address: null };
}
