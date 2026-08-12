/**
 * Audiences — who gets a brief.
 *
 * Each audience gets its own brief each day, built only from the mailboxes
 * assigned to it. Mail in one person's mailbox never appears in another
 * person's brief.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Audience {
  key: string;
  label: string;
  /** 07:00 email recipient. Empty means generate but do not email. */
  deliverTo: string;
  isDefault: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = resolve(here, '../../../config/audiences.json');

interface RawAudience {
  label?: string;
  deliverTo?: string;
  default?: boolean;
}

export function loadAudiences(path?: string): Audience[] {
  const file = path ?? process.env.AUDIENCES_CONFIG_PATH ?? DEFAULT_PATH;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    audiences?: Record<string, RawAudience>;
  };

  const entries = Object.entries(parsed.audiences ?? {});
  if (entries.length === 0) {
    // A hub with no audience would generate no briefs at all and say nothing
    // about why, so fail loudly at load instead.
    throw new Error(`No audiences defined in ${file}`);
  }

  const audiences = entries.map(([key, value], i) => ({
    key,
    label: value.label ?? key,
    deliverTo: value.deliverTo ?? '',
    isDefault: value.default ?? i === 0,
  }));

  // Exactly one default, so `defaultAudience()` is never ambiguous.
  if (!audiences.some((a) => a.isDefault)) audiences[0]!.isDefault = true;
  return audiences;
}

let cached: Audience[] | undefined;

export function audiences(): Audience[] {
  if (!cached) cached = loadAudiences();
  return cached;
}

export function reloadAudiences(path?: string): Audience[] {
  cached = loadAudiences(path);
  return cached;
}

export function audienceKeys(): string[] {
  return audiences().map((a) => a.key);
}

export function defaultAudience(): Audience {
  return audiences().find((a) => a.isDefault) ?? audiences()[0]!;
}

export function findAudience(key: string | null | undefined): Audience | undefined {
  if (!key) return undefined;
  return audiences().find((a) => a.key === key);
}

/**
 * Resolves a user-supplied audience key, falling back to the default. Used on
 * the OAuth start route, so an unknown key cannot create an orphaned mailbox
 * whose mail never reaches any brief.
 */
export function resolveAudience(key: string | null | undefined): Audience {
  return findAudience(key) ?? defaultAudience();
}
