/** @jsxImportSource preact */
/**
 * Render primitives (plan §6.3).
 *
 * Every string these components receive originates from a past user prompt, tool
 * output or LLM compression, so it is UNTRUSTED. They render it as text children
 * only. `dangerouslySetInnerHTML` appears nowhere in this bundle, and V1
 * deliberately renders no Markdown and auto-links no URLs or file paths — a
 * clickable path is an easy way to turn recorded data into an action.
 */

import type { ComponentChildren } from 'preact';

/** Untrusted single-line value. `break-anything` keeps a 5,000-char "word" inside its box. */
export function Text({ value, className }: { value: string | null | undefined; className?: string }) {
  return <span className={`t ${className ?? ''}`}>{value ?? ''}</span>;
}

/** Untrusted multi-line block: whitespace preserved, still a text node. */
export function Block({ value, className }: { value: string | null | undefined; className?: string }) {
  return <div className={`block ${className ?? ''}`}>{value ?? ''}</div>;
}

/** Raw payload / context text. Monospace, scrollable, never parsed. */
export function Raw({ value, maxHeight }: { value: string; maxHeight?: number }) {
  return (
    <pre className="raw" style={maxHeight ? { maxHeight: `${maxHeight}px` } : undefined}>
      {value}
    </pre>
  );
}

export function Chip({ children, tone }: { children: ComponentChildren; tone?: string }) {
  return <span className={`chip ${tone ? `chip-${tone}` : ''}`}>{children}</span>;
}

export function Field({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className="field-value">{children}</div>
    </div>
  );
}

export function Section({ title, children, actions }: { title: string; children: ComponentChildren; actions?: ComponentChildren }) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h3>{title}</h3>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Empty({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="empty">
      <p>{message}</p>
      {hint ? <p className="empty-hint">{hint}</p> : null}
    </div>
  );
}

/** Bounded list of untrusted strings with a "+N more" tail instead of a flood. */
export function TagList({ items, total, max = 6 }: { items: string[]; total?: number; max?: number }) {
  if (items.length === 0) return null;
  const shown = items.slice(0, max);
  const hidden = (total ?? items.length) - shown.length;
  return (
    <div className="taglist">
      {shown.map((item, i) => (
        <span className="tag" key={`${i}-${item}`}>
          {item}
        </span>
      ))}
      {hidden > 0 ? <span className="tag tag-more">{`+${hidden}`}</span> : null}
    </div>
  );
}
