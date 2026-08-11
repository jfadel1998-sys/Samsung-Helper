/**
 * Loader for the counterparty allowlist (§7.1 — "make the allowlist a config
 * file, not hardcoded. It will change weekly.").
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const COUNTERPARTY_TYPES = [
  'supplier',
  'freight_forwarder',
  'fabricator',
  'gc',
  'designer',
  'client',
  'internal',
  'unknown',
] as const;
export type CounterpartyType = (typeof COUNTERPARTY_TYPES)[number];

export interface CounterpartyConfig {
  domains: Record<string, CounterpartyType>;
  addresses: Record<string, CounterpartyType>;
  notificationSenders: string[];
  notificationDomains: string[];
  stoneKeywords: string[];
  projectKeywords: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = resolve(here, '../../../config/counterparties.json');

function normalizeKeys(rec: Record<string, string>): Record<string, CounterpartyType> {
  const out: Record<string, CounterpartyType> = {};
  for (const [k, v] of Object.entries(rec)) {
    out[k.trim().toLowerCase()] = (COUNTERPARTY_TYPES as readonly string[]).includes(v)
      ? (v as CounterpartyType)
      : 'unknown';
  }
  return out;
}

export function loadCounterpartyConfig(path?: string): CounterpartyConfig {
  const file = path ?? process.env.COUNTERPARTIES_CONFIG_PATH ?? DEFAULT_PATH;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CounterpartyConfig>;
  return {
    domains: normalizeKeys((parsed.domains ?? {}) as Record<string, string>),
    addresses: normalizeKeys((parsed.addresses ?? {}) as Record<string, string>),
    notificationSenders: (parsed.notificationSenders ?? []).map((s) => s.toLowerCase()),
    notificationDomains: (parsed.notificationDomains ?? []).map((s) => s.toLowerCase()),
    stoneKeywords: (parsed.stoneKeywords ?? []).map((s) => s.toLowerCase()),
    projectKeywords: (parsed.projectKeywords ?? []).map((s) => s.toLowerCase()),
  };
}

let cached: CounterpartyConfig | undefined;

/** Cached accessor for hot paths. `reloadCounterpartyConfig()` clears it. */
export function counterpartyConfig(): CounterpartyConfig {
  if (!cached) cached = loadCounterpartyConfig();
  return cached;
}

export function reloadCounterpartyConfig(path?: string): CounterpartyConfig {
  cached = loadCounterpartyConfig(path);
  return cached;
}

export function domainOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  if (at === -1) return null;
  return address.slice(at + 1).trim().toLowerCase().replace(/>$/, '');
}

/**
 * Allowlist hit for an address, matching the exact address first, then the
 * domain, then any parent domain (so `mail.supplier.com` matches an entry for
 * `supplier.com`).
 */
export function counterpartyTypeFor(
  address: string | null | undefined,
  cfg: CounterpartyConfig = counterpartyConfig(),
): CounterpartyType | null {
  if (!address) return null;
  const addr = address.trim().toLowerCase();
  const exact = cfg.addresses[addr];
  if (exact) return exact;

  const domain = domainOf(addr);
  if (!domain) return null;

  const direct = cfg.domains[domain];
  if (direct) return direct;

  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join('.');
    const hit = cfg.domains[parent];
    if (hit) return hit;
  }
  return null;
}

export function isAllowlistedCounterparty(
  address: string | null | undefined,
  cfg: CounterpartyConfig = counterpartyConfig(),
): boolean {
  return counterpartyTypeFor(address, cfg) !== null;
}
