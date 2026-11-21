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
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={box}>
        <div className="modal-head">
          <h2 id="modal-title">{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
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
      title={label}
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
