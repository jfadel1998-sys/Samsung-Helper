import type { Connector } from './types';
import { outlookConnector } from './outlook';
import { gmailConnector } from './gmail';
import { imapConnector } from './imap';

/**
 * The connector registry.
 *
 * Adding a source in a later phase (RSS, Instagram, Replit) is one new folder
 * under `packages/connectors` plus one row here. Nothing else moves — that is
 * the whole point of the interface in types.ts.
 */
const REGISTRY = new Map<string, Connector>([
  [outlookConnector.provider, outlookConnector],
  [gmailConnector.provider, gmailConnector],
  [imapConnector.provider, imapConnector],
]);

export function getConnector(provider: string): Connector {
  const connector = REGISTRY.get(provider);
  if (!connector) throw new Error(`Unknown connector provider: ${provider}`);
  return connector;
}

export function hasConnector(provider: string): boolean {
  return REGISTRY.has(provider);
}

export function listConnectors(): Connector[] {
  return [...REGISTRY.values()];
}
