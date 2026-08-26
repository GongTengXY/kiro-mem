/** @jsxImportSource preact */
/**
 * Workspace scope picker (plan §3.1).
 *
 * A listbox popup rather than a native `<select>`, so a row can carry the
 * basename, the full path, the Observation count and the last activity.
 *
 * Two constraints shaped it: the CSP is `style-src 'self'`, which drops inline
 * `style` attributes, so the popup is positioned by CSS and never by measured
 * coordinates; and a scope key is recorded data, so labels are text nodes clamped
 * by `text-overflow` rather than something that can widen the top bar.
 *
 * Keyboard: Arrow/Home/End move a cursor, Enter picks, Escape closes and returns
 * focus, Tab leaves.
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Check, ChevronDown, Folder, Globe } from 'lucide-preact';
import type { ViewerScope } from '../../server/viewer-types';
import { formatTime, scopeLabel } from '../merge';
import { useT } from '../i18n';

export const ALL_SCOPES_VALUE = '__all__';

const LISTBOX_ID = 'scope-listbox';

interface ScopeItem {
  value: string;
  label: string;
  /** Full scope key, shown under the label. `null` for the all-workspaces row. */
  path: string | null;
  count: string;
  note: string;
  global: boolean;
}

export function ScopePicker({
  scopes,
  scopeKey,
  allScopes,
  onChange,
}: {
  scopes: ViewerScope[];
  scopeKey: string | null;
  allScopes: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLUListElement>(null);
  const t = useT();

  const items = useMemo<ScopeItem[]>(() => {
    const total = scopes.reduce((n, s) => n + s.observations, 0);
    const list: ScopeItem[] = [
      {
        value: ALL_SCOPES_VALUE,
        label: t.allWorkspaces,
        path: null,
        count: String(total),
        note: t.workspacesCount(scopes.length),
        global: true,
      },
    ];
    // A launch scope the database has never recorded still has to be selectable.
    if (scopeKey && !scopes.some((s) => s.scopeKey === scopeKey)) {
      list.push({
        value: scopeKey,
        label: scopeLabel(scopeKey),
        path: scopeKey,
        count: '0',
        note: t.thisWorkspace,
        global: false,
      });
    }
    for (const s of scopes) {
      list.push({
        value: s.scopeKey,
        label: scopeLabel(s.scopeKey),
        path: s.scopeKey,
        count: String(s.observations),
        note: formatTime(s.lastActivityAt),
        global: false,
      });
    }
    return list;
  }, [scopes, scopeKey, t]);

  const currentValue = allScopes ? ALL_SCOPES_VALUE : (scopeKey ?? ALL_SCOPES_VALUE);
  const currentIndex = Math.max(0, items.findIndex((i) => i.value === currentValue));
  const current = items[currentIndex] ?? items[0]!;

  // Close on any click that lands outside the control.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the keyboard cursor inside the scroll box.
  useEffect(() => {
    if (!open) return;
    const el = popupRef.current?.querySelector<HTMLElement>('.is-active');
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const choose = (value: string) => {
    close(true);
    if (value !== currentValue) onChange(value);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        close(true);
      }
      return;
    }
    if (!open) {
      // Enter/Space would otherwise reach the button as a click and toggle twice.
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setActive(currentIndex);
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => Math.min(items.length - 1, i + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(items.length - 1);
        break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const item = items[active];
        if (item) choose(item.value);
        break;
      }
      default:
        break;
    }
  };

  return (
    <div className={`scope-picker ${open ? 'is-open' : ''}`} ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={triggerRef}
        className="scope-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={LISTBOX_ID}
        aria-activedescendant={open ? `scope-option-${active}` : undefined}
        aria-label={`${t.workspaceScope}: ${current.label}`}
        onClick={() => {
          setActive(currentIndex);
          setOpen((v) => !v);
        }}
      >
        <span className="scope-trigger-icon">{current.global ? <Globe size={15} /> : <Folder size={15} />}</span>
        <span className="scope-trigger-label">{current.label}</span>
        <span className="scope-trigger-count">{current.count}</span>
        <ChevronDown size={14} className="scope-chevron" />
      </button>

      {open ? (
        <ul className="scope-popup" id={LISTBOX_ID} role="listbox" ref={popupRef} aria-label={t.workspaceScope}>
          {items.map((item, i) => {
            const selected = item.value === currentValue;
            return (
              <li
                key={item.value}
                id={`scope-option-${i}`}
                role="option"
                aria-selected={selected}
                className={`scope-option ${i === active ? 'is-active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(item.value)}
              >
                <span className="scope-option-icon">{item.global ? <Globe size={15} /> : <Folder size={15} />}</span>
                <span className="scope-option-main">
                  <span className="scope-option-label">{item.label}</span>
                  {item.path ? (
                    <span className="scope-option-path" title={item.path}>
                      {item.path}
                    </span>
                  ) : (
                    <span className="scope-option-path scope-option-hint">{t.allWorkspacesHint}</span>
                  )}
                </span>
                <span className="scope-option-meta">
                  <span className="scope-option-count">{item.count}</span>
                  <span className="scope-option-note">{item.note}</span>
                </span>
                <span className="scope-option-check">{selected ? <Check size={14} /> : null}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
