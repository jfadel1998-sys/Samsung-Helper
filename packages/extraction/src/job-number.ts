/**
 * Job numbers — canonical format, tolerant parsing, normalization.
 *
 * THE CANONICAL FORM IS `NNNN` or `NNNN.S`
 *
 *   2269      a job
 *   2269.2    a sub-job / phase / release of job 2269
 *
 * Base is four digits. Sub-job is one or more digits with no leading zeros.
 * That is the form everything downstream stores, groups, and displays.
 *
 * Nobody types it that way consistently, so parsing is deliberately loose and
 * normalization is strict. All of these land on the same canonical `2269.2`:
 *
 *   2269.2   2269-2   2269_2   2269 . 2   #2269.2   Job 2269.2
 *   job#2269-2   PROJECT 2269.02   No. 2269.2
 *
 * That normalization is the whole point. Without it, one supplier writing
 * "2269-2" and another writing "#2269.2" produce two separate blocks in the
 * brief for the same job, which is exactly the failure the "By job" section
 * exists to prevent.
 *
 * Two confidence levels, because a bare four-digit number is ambiguous with
 * years, prices, and zip codes:
 *
 *   'marked' — preceded by an explicit marker (`job`, `project`, `#`, `no.`).
 *              Unambiguous, so the base may be 3-6 digits and no supporting
 *              vocabulary is needed.
 *   'bare'   — just the digits. Base must be exactly 4, and the caller should
 *              require stone/project vocabulary nearby before trusting it.
 */

export type JobNumberConfidence = 'marked' | 'bare';

export interface JobNumberMatch {
  /** Canonical form, e.g. "2269.2". */
  value: string;
  confidence: JobNumberConfidence;
  /** Offset of the match in the source text, for proximity checks. */
  index: number;
  /** The text as it actually appeared, e.g. "Job 2269-2". */
  raw: string;
}

const SEPARATOR = '[.\\-_]';
const MARKER = '(?:job|project|proj|prj|po|no|number|ref)\\s*(?:#|no\\.?|:)?\\s*|#\\s*';

/** Marked: an explicit marker immediately before the digits. */
const MARKED_RE = new RegExp(
  `(?<![a-z0-9])(?:${MARKER})(\\d{3,6})(?:\\s*${SEPARATOR}\\s*(\\d{1,3}))?(?![a-z0-9])`,
  'gi',
);

/** Bare: four digits, optional sub-job. Ambiguous without nearby vocabulary. */
const BARE_RE = new RegExp(
  `(?<![a-z0-9.\\-_])(\\d{4})(?:\\s*${SEPARATOR}\\s*(\\d{1,3}))?(?![a-z0-9])`,
  'gi',
);

/**
 * Canonicalizes a base and optional sub-job.
 *
 * Leading zeros are stripped from the sub-job, so "2269.02" and "2269.2" are
 * the same job. Zero-padded sub-jobs that are meant to be distinct would be a
 * pathological numbering scheme, and treating the two as different silently
 * splits a job's block in the brief.
 */
export function canonicalJobNumber(base: string, sub?: string | null): string {
  const b = base.trim();
  if (!sub) return b;
  const s = sub.trim().replace(/^0+(?=\d)/, '');
  return s ? `${b}.${s}` : b;
}

/** Every job-number-shaped token in `text`, in order of appearance. */
export function findJobNumbers(text: string): JobNumberMatch[] {
  if (!text) return [];

  const out: JobNumberMatch[] = [];
  const claimed: Array<[number, number]> = [];

  for (const m of text.matchAll(MARKED_RE)) {
    const index = m.index ?? 0;
    out.push({
      value: canonicalJobNumber(m[1]!, m[2]),
      confidence: 'marked',
      index,
      raw: m[0],
    });
    claimed.push([index, index + m[0].length]);
  }

  for (const m of text.matchAll(BARE_RE)) {
    const index = m.index ?? 0;
    // Skip digits already consumed by a marked match.
    if (claimed.some(([start, end]) => index >= start && index < end)) continue;
    out.push({
      value: canonicalJobNumber(m[1]!, m[2]),
      confidence: 'bare',
      index,
      raw: m[0],
    });
  }

  return out.sort((a, b) => a.index - b.index);
}

/**
 * Normalizes a job number the model returned, so extraction output is stored
 * in canonical form regardless of how the source email wrote it.
 *
 * Returns null when the string holds nothing job-number-shaped, which keeps a
 * hallucinated or malformed value out of the grouping key.
 */
export function normalizeJobNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const direct = /^\s*(?:#|job|project)?\s*(\d{3,6})(?:\s*[.\-_]\s*(\d{1,3}))?\s*$/i.exec(trimmed);
  if (direct) return canonicalJobNumber(direct[1]!, direct[2]);

  const found = findJobNumbers(trimmed);
  return found.length > 0 ? found[0]!.value : null;
}

/** Sorts canonical job numbers numerically rather than lexically. */
export function compareJobNumbers(a: string, b: string): number {
  const parse = (v: string): [number, number] => {
    const [base, sub] = v.split('.');
    return [Number(base) || 0, Number(sub ?? 0) || 0];
  };
  const [ab, as] = parse(a);
  const [bb, bs] = parse(b);
  return ab - bb || as - bs;
}
