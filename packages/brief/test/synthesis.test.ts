import { describe, expect, it, vi } from 'vitest';
import type { StoredExtraction } from '@hub/extraction';
import { groupForBrief, type BriefItem } from '../src/group';
import {
  buildSynthesisPayload,
  buildSynthesisPrompt,
  lintBrief,
  synthesize,
  SYNTHESIS_MODEL,
  type MessagesCreateClient,
} from '../src/synthesize';

const SECRET_BODY = 'CONFIDENTIAL-RAW-BODY-DO-NOT-SEND-TO-MODEL';

function extraction(over: Partial<StoredExtraction> = {}): StoredExtraction {
  return {
    external_id: 'msg-1',
    job_number: '2269.2',
    project_name: 'GVR Local Stone',
    counterparty: 'T. Nickolas',
    counterparty_type: 'supplier',
    category: 'pricing',
    summary: 'Confirmed revised pricing on 12 line items.',
    action_required: false,
    action_owner: 'none',
    blocking_question: null,
    urgency: 'normal',
    dates_mentioned: [],
    amounts_mentioned: [],
    vessel_or_container: null,
    ...over,
  };
}

function item(id: string, over: Partial<BriefItem> = {}, ex: Partial<StoredExtraction> = {}): BriefItem {
  return {
    eventId: id,
    threadId: `thread-${id}`,
    occurredAt: new Date(Date.UTC(2026, 7, 10, 12, 0)),
    url: `https://mail.example.com/${id}`,
    extraction: extraction(ex),
    daysOpen: null,
    ...over,
  };
}

function stubClient(text: string): MessagesCreateClient & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    create: vi.fn(async (params: Record<string, unknown>) => {
      calls.push(params);
      return {
        content: [{ type: 'text', text }],
        usage: { input_tokens: 900, output_tokens: 300 },
      };
    }),
  };
}

describe('grouping (§7.3)', () => {
  it('puts owner-actionable items in "Needs you today"', () => {
    const g = groupForBrief([
      item('a', {}, { action_required: true, action_owner: 'jason' }),
      item('b', {}, { action_required: true, action_owner: 'moet' }),
      item('c', {}, { action_required: false, action_owner: 'none' }),
    ]);
    expect(g.needsYouToday.map((i) => i.eventId)).toEqual(['a']);
  });

  it('orders within a group by urgency', () => {
    const g = groupForBrief([
      item('low', {}, { action_required: true, action_owner: 'jason', urgency: 'low' }),
      item('crit', {}, { action_required: true, action_owner: 'jason', urgency: 'critical' }),
      item('norm', {}, { action_required: true, action_owner: 'jason', urgency: 'normal' }),
    ]);
    expect(g.needsYouToday.map((i) => i.eventId)).toEqual(['crit', 'norm', 'low']);
  });

  it('groups by job number and keeps the project name', () => {
    const g = groupForBrief([
      item('a', {}, { job_number: '2269.2', project_name: 'GVR Local Stone' }),
      item('b', {}, { job_number: '2269.2', project_name: null }),
      item('c', {}, { job_number: '3310', project_name: 'Palms Tower' }),
    ]);
    expect(g.byJob.map((j) => j.jobNumber).sort()).toEqual(['2269.2', '3310']);
    const gvr = g.byJob.find((j) => j.jobNumber === '2269.2')!;
    expect(gvr.projectName).toBe('GVR Local Stone');
    expect(gvr.items).toHaveLength(2);
  });

  it('sorts waiting items by days open, longest first', () => {
    const g = groupForBrief([
      item('short', { daysOpen: 1 }, { blocking_question: 'FOB terms?' }),
      item('long', { daysOpen: 9 }, { blocking_question: 'Vessel confirmation?' }),
      item('mid', { daysOpen: 3 }, { blocking_question: 'Sample approval?' }),
    ]);
    expect(g.waitingOnOthers.map((i) => i.eventId)).toEqual(['long', 'mid', 'short']);
  });

  it('excludes a blocking question whose thread is not actually waiting', () => {
    // daysOpen null means the owner has since replied — not waiting on anyone.
    const g = groupForBrief([item('answered', { daysOpen: null }, { blocking_question: 'FOB?' })]);
    expect(g.waitingOnOthers).toHaveLength(0);
  });

  it('does not repeat an item across sections', () => {
    const g = groupForBrief([
      item(
        'both',
        { daysOpen: 4 },
        { action_required: true, action_owner: 'jason', blocking_question: 'FOB terms?' },
      ),
    ]);
    expect(g.needsYouToday).toHaveLength(1);
    expect(g.waitingOnOthers).toHaveLength(1);
    // ...but it must not also show up again under its job block or the tail.
    expect(g.byJob).toHaveLength(0);
    expect(g.everythingElse).toHaveLength(0);
  });

  it('falls back to counterparty, then to loose items', () => {
    const g = groupForBrief([
      item('cp', {}, { job_number: null, counterparty: 'Genoa Shipping' }),
      item('loose', {}, { job_number: null, counterparty: null }),
    ]);
    expect(g.byJob).toHaveLength(0);
    expect(g.everythingElse.map((i) => i.eventId)).toEqual(['cp', 'loose']);
  });

  it('is stable across runs on the same input', () => {
    const items = [
      item('a', {}, { job_number: '3310' }),
      item('b', {}, { job_number: '2269.2' }),
      item('c', {}, { job_number: '1180' }),
    ];
    const first = groupForBrief(items).byJob.map((j) => j.jobNumber);
    const second = groupForBrief(items).byJob.map((j) => j.jobNumber);
    expect(first).toEqual(second);
  });
});

describe('the model never sees raw bodies (§7.3)', () => {
  it('omits every field that is not part of the extraction', () => {
    const grouped = groupForBrief([
      item('a', {
        // Fields that exist on the row but must not reach the model.
        url: `https://mail.example.com/${SECRET_BODY}`,
      }),
    ]);

    const payload = JSON.stringify(buildSynthesisPayload(grouped));
    expect(payload).not.toContain(SECRET_BODY);
    expect(payload).not.toContain('bodyExcerpt');
    expect(payload).not.toContain('eventId');
    expect(payload).toContain('Confirmed revised pricing');
  });

  it('keeps the prompt free of raw content end to end', async () => {
    const grouped = groupForBrief([item('a', { url: SECRET_BODY })]);
    const client = stubClient('## Needs you today\n- something');
    await synthesize(client, grouped, '2026-08-11');

    const sent = JSON.stringify(client.calls[0]);
    expect(sent).not.toContain(SECRET_BODY);
  });

  it('drops null extraction fields rather than sending nulls to reason about', () => {
    const grouped = groupForBrief([
      item('a', {}, { job_number: null, project_name: null, vessel_or_container: null }),
    ]);
    const payload = JSON.stringify(buildSynthesisPayload(grouped));
    expect(payload).not.toContain('null');
  });

  it('passes the SQL-computed days-open through verbatim', () => {
    const grouped = groupForBrief([
      item('a', { daysOpen: 3 }, { blocking_question: 'FOB terms?' }),
    ]);
    const payload = buildSynthesisPayload(grouped);
    expect(JSON.stringify(payload)).toContain('"days_open":3');
  });
});

describe('synthesis request', () => {
  it('targets Sonnet 5 without sampling parameters', async () => {
    const grouped = groupForBrief([item('a')]);
    const client = stubClient('## Everything else\n- a thing');
    await synthesize(client, grouped, '2026-08-11');

    const params = client.calls[0]!;
    expect(params.model).toBe(SYNTHESIS_MODEL);
    expect(SYNTHESIS_MODEL).toBe('claude-sonnet-5');
    // Sonnet 5 returns a 400 for any of these.
    expect(params.temperature).toBeUndefined();
    expect(params.top_p).toBeUndefined();
    expect(params.top_k).toBeUndefined();
    // max_tokens must leave room for adaptive thinking, which is on by default.
    expect(params.max_tokens as number).toBeGreaterThanOrEqual(8000);
  });

  it('instructs the model to omit empty sections', () => {
    const prompt = buildSynthesisPrompt(groupForBrief([item('a')]), '2026-08-11');
    expect(prompt).toContain('Omit any whose list is empty');
    expect(prompt).toContain('2026-08-11');
  });

  it('reports token usage for the briefs row', async () => {
    const client = stubClient('## Everything else\n- a thing');
    const result = await synthesize(client, groupForBrief([item('a')]), '2026-08-11');
    expect(result.inputTokens).toBe(900);
    expect(result.outputTokens).toBe(300);
  });
});

describe('brief lint (§7.3 output rules)', () => {
  it('accepts a brief that reads the way the spec wants', () => {
    const good = `## Needs you today
- **2269.2 GVR Local Stone** — T. Nickolas confirmed revised pricing on 12 line items.

## Waiting on others
- Moet still waiting on FOB clarification from the supplier (3 days open).`;
    expect(lintBrief(good)).toEqual([]);
  });

  it('flags unread counts', () => {
    expect(lintBrief('You have 14 unread emails and 3 meetings today.')).toContain(
      'counts unread mail',
    );
    expect(lintBrief('There are 6 new messages since yesterday.')).toContain('counts unread mail');
  });

  it('flags a preamble', () => {
    expect(lintBrief("Here's your brief for today.\n\n## Needs you today")).toContain('preamble');
  });

  it('flags encouragement', () => {
    expect(lintBrief('Good morning! ## Needs you today')).toContain('greeting or encouragement');
    expect(lintBrief("You've got this.")).toContain('encouragement');
  });

  it('does not flag a legitimate line containing a number', () => {
    expect(lintBrief('- T. Nickolas confirmed revised pricing on 12 line items.')).toEqual([]);
    expect(lintBrief('- Genoa vessel change unresolved (3 days open).')).toEqual([]);
  });
});
