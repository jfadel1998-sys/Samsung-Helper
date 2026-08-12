/**
 * §M6 delivery. Renders the brief to email HTML and sends it.
 *
 * Delivery is optional: with no provider configured the job logs and returns
 * rather than failing. The brief is already persisted and readable at
 * /brief/[date], so a missing API key should not turn into a retry storm on
 * the queue every morning.
 */

export interface DeliveryConfig {
  apiKey: string;
  from: string;
  to: string;
}

export interface DeliveryResult {
  delivered: boolean;
  reason?: string;
  providerId?: string;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** The brief is model-generated, so everything is escaped before any markup. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

function inline(text: string): string {
  // Escape first, then apply formatting to the escaped text — the reverse
  // order would let generated markup survive into the email.
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Markdown subset -> email-safe HTML. Same subset the web renderer handles. */
export function briefToHtml(markdown: string, briefDate: string): string {
  const parts: string[] = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      parts.push('</ul>');
      inList = false;
    }
  };

  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!inList) {
        parts.push('<ul style="margin:6px 0 14px;padding-left:20px">');
        inList = true;
      }
      parts.push(`<li style="margin:4px 0">${inline(bullet[1]!)}</li>`);
      continue;
    }

    closeList();
    if (line.trim() === '') continue;

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const style =
        level <= 2
          ? 'font-size:16px;margin:26px 0 6px;padding-bottom:4px;border-bottom:1px solid #e4e6ea'
          : 'font-size:14px;margin:16px 0 4px';
      parts.push(`<h${level <= 2 ? 2 : 3} style="${style}">${inline(heading[2]!)}</h${level <= 2 ? 2 : 3}>`);
      continue;
    }

    parts.push(`<p style="margin:8px 0">${inline(line)}</p>`);
  }
  closeList();

  return `<!doctype html>
<html><body style="margin:0;background:#f6f7f9">
<div style="max-width:640px;margin:0 auto;padding:24px 20px 40px;background:#ffffff;color:#16181d;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="font-size:12px;color:#61656e;margin-bottom:18px">${escapeHtml(briefDate)}</div>
${parts.join('\n')}
</div>
</body></html>`;
}

/** Plaintext alternative — the Markdown is already readable as-is. */
export function briefToText(markdown: string): string {
  return markdown;
}

export function deliveryConfigFromEnv(): DeliveryConfig | null {
  const apiKey = process.env.RESEND_API_KEY ?? '';
  const from = process.env.BRIEF_FROM_ADDRESS ?? '';
  const to = process.env.BRIEF_TO_ADDRESS ?? '';
  if (!apiKey || !from || !to) return null;
  return { apiKey, from, to };
}

/**
 * Sends via Resend's REST API directly rather than adding a client library —
 * it is one POST, and the dependency would not earn its place.
 */
export async function deliverBrief(
  config: DeliveryConfig | null,
  input: { briefDate: string; markdown: string },
): Promise<DeliveryResult> {
  if (!config) {
    return {
      delivered: false,
      reason: 'delivery not configured (RESEND_API_KEY / BRIEF_FROM_ADDRESS / BRIEF_TO_ADDRESS)',
    };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: config.from,
      to: [config.to],
      subject: `Brief — ${input.briefDate}`,
      html: briefToHtml(input.markdown, input.briefDate),
      text: briefToText(input.markdown),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    // Never echo the whole provider response — it can contain the recipient
    // list and request metadata.
    return { delivered: false, reason: `resend ${res.status}: ${body.slice(0, 200)}` };
  }

  const body = (await res.json()) as { id?: string };
  return { delivered: true, ...(body.id ? { providerId: body.id } : {}) };
}
