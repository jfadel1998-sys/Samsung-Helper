/**
 * pg-boss wiring shared by the worker (which runs jobs) and the web app
 * (which enqueues them from webhook receivers).
 */
import PgBoss from 'pg-boss';
import { env } from '@hub/config';

export const QUEUES = {
  syncAccount: 'sync-account',
  renewSubscriptions: 'renew-subscriptions',
  extractEvents: 'extract-events',
  generateBrief: 'generate-brief',
  deliverBrief: 'deliver-brief',
  tokenHealth: 'token-health',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface SyncAccountJob {
  accountId: string;
  /** 'webhook' | 'poll' | 'manual' — for logging only. */
  trigger: string;
  /** Force a bounded full sync instead of delta. */
  full?: boolean;
}

export interface ExtractEventsJob {
  batchSize?: number;
}

export interface GenerateBriefJob {
  /** YYYY-MM-DD in the brief timezone. Defaults to today. */
  briefDate?: string;
}

export interface DeliverBriefJob {
  briefDate: string;
}

/** §8: exponential backoff, max 5 retries. */
const RETRY = { retryLimit: 5, retryDelay: 30, retryBackoff: true } as const;

const QUEUE_CONFIG: PgBoss.Queue[] = [
  // 'stately' keeps at most one queued + one active job per singletonKey, which
  // is how we hold Gmail/Graph to one concurrent sync per account (§8).
  { name: QUEUES.syncAccount, policy: 'stately', expireInMinutes: 15, ...RETRY },
  { name: QUEUES.renewSubscriptions, policy: 'singleton', expireInMinutes: 10, ...RETRY },
  { name: QUEUES.extractEvents, policy: 'singleton', expireInMinutes: 15, ...RETRY },
  { name: QUEUES.generateBrief, policy: 'singleton', expireInMinutes: 10, ...RETRY },
  { name: QUEUES.deliverBrief, policy: 'singleton', expireInMinutes: 10, ...RETRY },
  { name: QUEUES.tokenHealth, policy: 'singleton', expireInMinutes: 10, ...RETRY },
];

let boss: PgBoss | undefined;
let starting: Promise<PgBoss> | undefined;

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  if (starting) return starting;

  starting = (async () => {
    const instance = new PgBoss({
      connectionString: env.databaseUrl,
      // pg-boss keeps its own tables out of the app schema.
      schema: 'pgboss',
      max: 5,
      ...(env.databaseUrl.includes('localhost') ? {} : { ssl: { rejectUnauthorized: false } }),
    });
    instance.on('error', (err) => console.error('[pg-boss]', err));
    await instance.start();
    for (const q of QUEUE_CONFIG) {
      await instance.createQueue(q.name, q);
    }
    boss = instance;
    return instance;
  })();

  return starting;
}

export async function stopBoss() {
  if (boss) {
    await boss.stop({ graceful: true, wait: true });
    boss = undefined;
    starting = undefined;
  }
}

/**
 * Enqueue a sync for one account. `singletonKey` collapses a burst of webhook
 * notifications for the same mailbox into a single pending job — providers fire
 * one notification per message and we only need "something changed, go sync"
 * (§9).
 */
export async function enqueueSync(job: SyncAccountJob) {
  const b = await getBoss();
  return b.send(QUEUES.syncAccount, job, { singletonKey: job.accountId });
}

export async function enqueueExtraction(job: ExtractEventsJob = {}) {
  const b = await getBoss();
  return b.send(QUEUES.extractEvents, job);
}

export async function enqueueBrief(job: GenerateBriefJob = {}) {
  const b = await getBoss();
  return b.send(QUEUES.generateBrief, job);
}
