import type { ReactNode } from 'react';

/**
 * Minimal renderer for the subset of Markdown the brief actually uses:
 * headings, bullets, bold, italic, and inline code.
 *
 * Hand-rolled rather than pulled from a library because the input is
 * model-generated text. Everything is emitted as React elements, so it is
 * escaped by construction — there is no `dangerouslySetInnerHTML` anywhere in
 * this path and no HTML in the brief can execute.
 */

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*')) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    return <span key={key}>{part}</span>;
  });
}

export function renderBriefMarkdown(markdown: string): ReactNode[] {
  const out: ReactNode[] = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length === 0) return;
    const items = listItems;
    listItems = [];
    out.push(
      <ul key={`ul-${out.length}`}>
        {items.map((text, i) => (
          <li key={i}>{renderInline(text, `li-${out.length}-${i}`)}</li>
        ))}
      </ul>,
    );
  };

  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      listItems.push(bullet[1]!);
      continue;
    }

    flushList();

    if (line.trim() === '') continue;

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const content = renderInline(heading[2]!, `h-${out.length}`);
      const key = `h-${out.length}`;
      out.push(
        level <= 2 ? <h2 key={key}>{content}</h2> : <h3 key={key}>{content}</h3>,
      );
      continue;
    }

    out.push(<p key={`p-${out.length}`}>{renderInline(line, `p-${out.length}`)}</p>);
  }

  flushList();
  return out;
}
