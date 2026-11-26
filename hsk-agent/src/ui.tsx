import { createPortal } from 'react-dom';
// Interaction pieces modelled on ChatGPT / Perplexity / Hume AI (Mobbin): confirm modal, toast, copy action,
// and reply text that renders "- " lines as a real list. Visual style follows the existing Moa theme.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/* ---------- modal ---------- */

export function Modal({ title, children, onClose, actions }: { title: string; children: ReactNode; onClose: () => void; actions: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // Focus the primary action (last button) so Enter confirms and Esc cancels, like ChatGPT's dialogs.
    const buttons = box.current?.querySelectorAll<HTMLButtonElement>('.modal-actions button');
    buttons?.[buttons.length - 1]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && box.current) {
        // keep focus inside the dialog
        const f = box.current.querySelectorAll<HTMLElement>('button, a, input, textarea');
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; prev?.focus(); };
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={box}>
        <div className="modal-head">
          <h2 id="modal-title">{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">{actions}</div>
      </div>
    </div>,
    document.body,
  );
}

/* ---------- toast ---------- */

type Toast = { id: number; text: string };
const ToastContext = createContext<(text: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, text }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 2600);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className="toast">
            <span className="toast-check" aria-hidden>✓</span>{x.text}
            <button className="icon-btn sm" onClick={() => setToasts((ts) => ts.filter((y) => y.id !== x.id))} aria-label="Dismiss">✕</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ---------- copy action ---------- */

export function CopyButton({ text, label, done }: { text: string; label: string; done: string }) {
  const toast = useToast();
  const [ok, setOk] = useState(false);
  return (
    <button
      className="icon-btn sm"
      aria-label={label}
      data-tip={label}
      onClick={() => {
        const ok = () => { setOk(true); toast(done); setTimeout(() => setOk(false), 1500); };
        // Clipboard API first; older or locked-down browsers fall back to a hidden textarea.
        const fallback = () => {
          const ta = document.createElement('textarea');
          ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          try { if (document.execCommand('copy')) ok(); } finally { ta.remove(); }
        };
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(ok, fallback);
        else fallback();
      }}
    >
      {ok
        ? <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        : <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><rect x="5" y="5" width="8.5" height="8.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 3.5V3a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>}
    </button>
  );
}

/* ---------- overflow menu (ChatGPT "⋯") ---------- */

export interface MenuItem { label: string; danger?: boolean; onSelect: () => void }

export function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const first = root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]');
    first?.focus();
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      const list = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
      const i = list.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'Escape') { setOpen(false); root.current?.querySelector<HTMLButtonElement>('.menu-trigger')?.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div className="menu" ref={root}>
      <button className="icon-btn menu-trigger" aria-label={label} data-tip={open ? undefined : label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><circle cx="3.5" cy="8" r="1.4" fill="currentColor" /><circle cx="8" cy="8" r="1.4" fill="currentColor" /><circle cx="12.5" cy="8" r="1.4" fill="currentColor" /></svg>
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {items.map((it) => (
            <button key={it.label} role="menuitem" className={it.danger ? 'danger' : ''} onClick={() => { setOpen(false); it.onSelect(); }}>
              {it.danger && <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- address that copies on click ---------- */

export function CopyAddress({ value, label, done }: { value: string; label: string; done: string }) {
  const toast = useToast();
  return (
    <button className="addr" data-tip={value} aria-label={`${label}: ${value}`}
      onClick={() => { void navigator.clipboard?.writeText(value).then(() => toast(done), () => undefined); }}>
      <code>{value.slice(0, 6)}…{value.slice(-4)}</code>
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden><rect x="5" y="5" width="8.5" height="8.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 3.5V3a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
    </button>
  );
}

/* ---------- reply text ---------- */

/** **bold** spans inside a line. */
function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (/^\*\*[^*]+\*\*$/.test(part) ? <strong key={i}>{part.slice(2, -2)}</strong> : part));
}

/** Paragraphs as text; consecutive "- " or "• " lines become a real bulleted list; **bold** is bold. */
export function RichText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flushPara = () => { if (para.length) { blocks.push(<p key={blocks.length}>{inline(para.join('\n'))}</p>); para = []; } };
  const flushList = () => { if (list.length) { blocks.push(<ul key={blocks.length}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>); list = []; } };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const m = /^\s*[-•*]\s+(.*)$/.exec(line);
    if (m) { flushPara(); list.push(m[1]); }
    else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return <div className="rich">{blocks}</div>;
}

/** Something did not load: what, why in one line, and a way to try again. Used wherever data can fail. */
export function StateBox({ title, text, retry, onRetry, compact }: { title: string; text?: string; retry?: string; onRetry?: () => void; compact?: boolean }) {
  return (
    <div className={`state-box${compact ? ' compact' : ''}`} role="alert">
      <span className="sb-ic" aria-hidden>
        <svg width="18" height="18" viewBox="0 0 24 24"><path d="M12 8v5M12 16.5h.01M10.3 4.2 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
      <div className="sb-text"><b>{title}</b>{text && <p>{text}</p>}</div>
      {onRetry && retry && <button className="btn" onClick={onRetry}>{retry}</button>}
    </div>
  );
}
