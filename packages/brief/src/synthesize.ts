/**
 * Stage 3 — synthesis (§7.3).
 *
 * Input is ONLY the extracted structs. Raw bodies never reach this stage —
 * `buildSynthesisPayload` is built from `extracted` fields exclusively, and the
 * test suite asserts that a body excerpt cannot leak into the prompt.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { BriefItem, GroupedBrief } from './group';

/** §3 assigns synthesis to Sonnet 5. */
export const SYNTHESIS_MODEL = 'claude-sonnet-5';

/**
 * `max_tokens` bounds thinking + response together, and Sonnet 5 runs adaptive
 * thinking by default. 8000 leaves the model room to think and still emit a
 * full brief; the brief itself is well under 2000 tokens.
 */
const MAX_TOKENS = 8_000;

export const SYNTHESIS_SYSTEM_PROMPT = `You write a daily operating brief for Jason, who owns Traxtone, a Las Vegas project-management firm handling imported natural stone, porcelain, and engineered slabs and tile for large commercial projects — hotels, resorts, casinos — and high-end residential.

You are given structured facts already extracted from his mail, pre-grouped and pre-sorted. Turn them into the brief. Do not re-sort, re-group, or re-prioritize; the grouping given to you is the grouping.

Write in Markdown, using only the section headers you are given, in the order given. Omit any section header whose list is empty — never write a header followed by "nothing here".

Every line states a specific fact drawn from the input: who, what, which job, what is pending. Name people and companies. Use the job number and project name when you have them.

Do not write a preamble, a greeting, a title, a sign-off, or a closing summary. Do not open with "Here's your brief" or similar. Do not offer encouragement, advice, or commentary on how the day looks. Do not count messages — never write anything of the form "you have N unread" or "N items need attention". The reader can count.

Do not invent, infer, or round. If a field is null it was not stated, so leave it out rather than guessing. Do not compute or adjust dates — where a days-open figure is supplied, use that number exactly as given.

For each item, write one line: the fact, then what is pending if anything. Combine several facts about the same job into consecutive lines under that job's block rather than repeating the job header.

Where an item has been open for a number of days, state it as given, e.g. "(3 days open)".`;

export interface SynthesisResult {
  markdown: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface MessagesCreateClient {
  create(params: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  }>;
}

export function defaultSynthesisClient(apiKey?: string): MessagesCreateClient {
  const client = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY });
  return client.messages as unknown as MessagesCreateClient;
}

/** One item, reduced to the extracted fields only. */
function line(item: BriefItem): Record<string, unknown> {
  const e = item.extraction;
  const out: Record<string, unknown> = {
    summary: e.summary,
    category: e.category,
    urgency: e.urgency,
  };
  if (e.job_number) out.job_number = e.job_number;
  if (e.project_name) out.project_name = e.project_name;
  if (e.counterparty) out.counterparty = e.counterparty;
  if (e.counterparty_type && e.counterparty_type !== 'unknown') {
    out.counterparty_type = e.counterparty_type;
  }
  if (e.blocking_question) out.blocking_question = e.blocking_question;
  if (e.action_required) out.action_owner = e.action_owner;
  if (e.dates_mentioned.length) out.dates_mentioned = e.dates_mentioned;
  if (e.amounts_mentioned.length) out.amounts_mentioned = e.amounts_mentioned;
  if (e.vessel_or_container) out.vessel_or_container = e.vessel_or_container;
  if (item.daysOpen !== null) out.days_open = item.daysOpen;
  return out;
}

/**
 * Builds the model payload. Deliberately constructed field by field from the
 * extraction rather than by spreading the row — a spread would silently start
 * shipping raw bodies the moment a new column is added.
 */
export function buildSynthesisPayload(grouped: GroupedBrief): Record<string, unknown> {
  return {
    needs_you_today: grouped.needsYouToday.map(line),
    by_job: grouped.byJob.map((g) => ({
      job_number: g.jobNumber,
      project_name: g.projectName,
      items: g.items.map(line),
    })),
    waiting_on_others: grouped.waitingOnOthers.map(line),
    everything_else: grouped.everythingElse.map(line),
  };
}

const SECTION_HEADERS = [
  '## Needs you today   (from needs_you_today)',
  '## By job            (from by_job — one "### <job_number> <project_name>" block each)',
  '## Waiting on others (from waiting_on_others)',
  '## Everything else   (from everything_else — one line each)',
].join('\n');

export function buildSynthesisPrompt(grouped: GroupedBrief, briefDate: string): string {
  return (
    `Brief date: ${briefDate}\n\n` +
    `Section headers, in order. Omit any whose list is empty:\n${SECTION_HEADERS}\n\n` +
    `Extracted facts:\n\n${JSON.stringify(buildSynthesisPayload(grouped), null, 2)}`
  );
}

export async function synthesize(
  client: MessagesCreateClient,
  grouped: GroupedBrief,
  briefDate: string,
): Promise<SynthesisResult> {
  const response = await client.create({
    model: SYNTHESIS_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYNTHESIS_SYSTEM_PROMPT,
    // Sonnet 5 rejects temperature/top_p/top_k outright, so consistency comes
    // from the prompt and the pre-sorted input, not from sampling parameters.
    output_config: { effort: 'medium' },
    messages: [{ role: 'user', content: buildSynthesisPrompt(grouped, briefDate) }],
  });

  const markdown = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();

  return {
    markdown,
    model: SYNTHESIS_MODEL,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}

/** Sonnet 5 list pricing, USD per million tokens. */
export const SONNET_PRICING = { inputPerMTok: 3.0, outputPerMTok: 15.0 } as const;

export function estimateSynthesisCostUsd(r: { inputTokens: number; outputTokens: number }): number {
  return (
    (r.inputTokens / 1_000_000) * SONNET_PRICING.inputPerMTok +
    (r.outputTokens / 1_000_000) * SONNET_PRICING.outputPerMTok
  );
}

/**
 * Guardrails on the model's output (§7.3 "rules for the synthesis prompt").
 * Reported, not enforced — a brief that trips one is still delivered, but the
 * violation is logged and shown on /ops so the prompt can be tuned.
 */
const BANNED_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /\byou have \d+\b/i, what: 'counts unread mail' },
  { re: /\b\d+ (unread|new) (emails?|messages?)\b/i, what: 'counts unread mail' },
  { re: /^(here'?s|here is)\b/im, what: 'preamble' },
  { re: /\bgood (morning|luck)\b/i, what: 'greeting or encouragement' },
  { re: /\byou'?ve got this\b/i, what: 'encouragement' },
];

export function lintBrief(markdown: string): string[] {
  return BANNED_PATTERNS.filter((p) => p.re.test(markdown)).map((p) => p.what);
}
