import { afterEach, describe, expect, it, vi } from 'vitest';
import { briefToHtml, deliverBrief, escapeHtml, type DeliveryConfig } from '../src/deliver';

const CONFIG: DeliveryConfig = {
  apiKey: 'test-key',
  from: 'brief@traxtone.com',
  to: 'jason@traxtone.com',
};

afterEach(() => vi.unstubAllGlobals());

describe('brief HTML rendering', () => {
  it('renders headings, bullets, and bold', () => {
    const html = briefToHtml(
      '## Needs you today\n- **2269.2 GVR** — pricing confirmed\n\n### 2269.2\n- another line',
      '2026-08-11',
    );
    expect(html).toContain('<h2');
    expect(html).toContain('<h3');
    expect(html).toContain('<strong>2269.2 GVR</strong>');
    expect(html).toContain('<li');
    expect(html).toContain('2026-08-11');
  });

  it('closes lists before the next heading', () => {
    const html = briefToHtml('## A\n- one\n- two\n\n## B\n- three', '2026-08-11');
    expect(html.match(/<ul/g)).toHaveLength(2);
    expect(html.match(/<\/ul>/g)).toHaveLength(2);
  });

  // The brief is model output, so escaping is not optional.
  it('escapes HTML in the brief body', () => {
    const html = briefToHtml('- <script>alert(1)</script> and A & B', '2026-08-11');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('A &amp; B');
  });

  it('escapes before applying formatting, not after', () => {
    // If formatting ran first, this would emit a live <b> tag.
    const html = briefToHtml('- **<b>bold</b>**', '2026-08-11');
    expect(html).toContain('<strong>&lt;b&gt;bold&lt;/b&gt;</strong>');
  });

  it('escapes the brief date too', () => {
    expect(briefToHtml('- x', '<img onerror=1>')).not.toContain('<img');
  });

  it('escapes quotes and apostrophes', () => {
    expect(escapeHtml(`"quoted" and 'single'`)).toBe('&quot;quoted&quot; and &#39;single&#39;');
  });

  it('handles an empty brief without producing broken markup', () => {
    const html = briefToHtml('', '2026-08-11');
    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('<ul');
  });
});

describe('delivery', () => {
  it('no-ops when delivery is not configured', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await deliverBrief(null, { briefDate: '2026-08-11', markdown: '- x' });

    expect(result.delivered).toBe(false);
    expect(result.reason).toContain('not configured');
    // Critically: it does not throw, so pg-boss does not retry a missing key
    // every morning forever.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts html and text alternatives', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ id: 'email-123' })));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await deliverBrief(CONFIG, {
      briefDate: '2026-08-11',
      markdown: '## Needs you today\n- **2269.2 GVR** — pricing confirmed',
    });

    expect(result.delivered).toBe(true);
    expect(result.providerId).toBe('email-123');

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    const body = JSON.parse(init.body as string);
    expect(body.subject).toBe('Brief — 2026-08-11');
    expect(body.to).toEqual(['jason@traxtone.com']);
    expect(body.html).toContain('<strong>');
    expect(body.text).toContain('## Needs you today');
  });

  it('reports a provider failure without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('domain not verified', { status: 403 })),
    );

    const result = await deliverBrief(CONFIG, { briefDate: '2026-08-11', markdown: '- x' });
    expect(result.delivered).toBe(false);
    expect(result.reason).toContain('403');
  });

  it('truncates the provider error rather than logging the whole response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(5000), { status: 500 })),
    );

    const result = await deliverBrief(CONFIG, { briefDate: '2026-08-11', markdown: '- x' });
    expect(result.reason!.length).toBeLessThan(260);
  });
});
