import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ago, timeOnly } from '../lib/format.ts';

// ---- icons (single-stroke, drawn for this interface) -----------------------------
const I = (d: ReactNode) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);
export const Icon = {
  situation: I(<><circle cx="10" cy="10" r="6.5" /><path d="M10 1.5v4M10 14.5v4M1.5 10h4M14.5 10h4" /></>),
  intel: I(<><circle cx="10" cy="10" r="7.5" /><path d="M2.5 10h15M10 2.5c2.4 2.2 3.6 4.7 3.6 7.5s-1.2 5.3-3.6 7.500c-2.4-2.2-3.6-4.7-3.6-7.500S7.6 4.7 10 2.500Z" /></>),
  markets: I(<><path d="M2.5 16.500h15" /><path d="M5 13V8M5 6.500V5M10 14V9.500M10 8V4M15 11V6.500M15 5V3" /></>),
  personal: I(<><path d="M3 15.5 7.5 10l3 3L17 5.5" /><path d="M12.5 5.500H17V10" /></>),
  analyst: I(<><path d="M4 4.500h12v8.500H9.500L6 16v-3H4Z" /><path d="M7.5 8h5M7.5 10.300h3" /></>),
  search: I(<><circle cx="9" cy="9" r="5.5" /><path d="m13.2 13.2 3.8 3.8" /></>),
  refresh: I(<><path d="M16.5 10a6.5 6.5 0 1 1-2-4.7" /><path d="M16.5 3.500v3.300h-3.3" /></>),
  plus: I(<path d="M10 4v12M4 10h12" />),
  minus: I(<path d="M4 10h12" />),
  close: I(<path d="m5 5 10 10M15 5 5 15" />),
  check: I(<path d="m4.5 10.5 3.5 3.5 7.5-8" />),
  trash: I(<><path d="M4 6h12M8 6V4h4v2M6 6l.7 10h6.600L14 6" /></>),
  alert: I(<><path d="M10 3 2.5 16h15Z" /><path d="M10 8v4M10 14.200v.1" /></>),
  external: I(<><path d="M8 5H5v10h10v-3" /><path d="M11 4h5v5M16 4l-7 7" /></>),
  empty: I(<><rect x="3" y="4" width="14" height="12" rx="1.5" /><path d="M3 12h4l1 2h4l1-2h4" /></>),
  send: I(<path d="M3 10 17 3.5 13 17l-3-5.500Z" />),
  stop: I(<rect x="5.5" y="5.5" width="9" height="9" rx="1" />),
  upload: I(<><path d="M10 13V4M6.5 7.5 10 4l3.5 3.5" /><path d="M4 13v3h12v-3" /></>),
  edit: I(<><path d="m4 16 .7-3.200L13.5 4l2.5 2.5-8.8 8.800Z" /></>),
  file: I(<><path d="M6 3h6l3 3v11H6Z" /><path d="M12 3v3h3M8.5 10h4M8.5 13h4" /></>),
};

// ---- structure -------------------------------------------------------------------
export function Panel(props: { title?: ReactNode; meta?: ReactNode; actions?: ReactNode; foot?: ReactNode; flush?: boolean; children: ReactNode; className?: string; label?: string }) {
  return (
    <section className={`panel ${props.className ?? ''}`} aria-label={props.label ?? (typeof props.title === 'string' ? props.title : undefined)}>
      {(props.title || props.actions) && (
        <header className="panel-head">
          {props.title && <h2>{props.title}</h2>}
          {props.meta && <span className="meta">{props.meta}</span>}
          {props.actions && <div className="actions">{props.actions}</div>}
        </header>
      )}
      <div className={`panel-body ${props.flush ? 'flush' : ''}`}>{props.children}</div>
      {props.foot && <footer className="panel-foot">{props.foot}</footer>}
    </section>
  );
}

export function Stat(props: { label: string; value: ReactNode; sub?: ReactNode; large?: boolean; tone?: string }) {
  return (
    <div className="stat">
      <span className="label">{props.label}</span>
      <span className={`value ${props.large ? 'lg' : ''} ${props.tone ?? ''}`}>{props.value}</span>
      {props.sub && <span className="sub">{props.sub}</span>}
    </div>
  );
}

export function Empty(props: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      {props.icon ?? Icon.empty}
      <h3>{props.title}</h3>
      {props.children && <p>{props.children}</p>}
      {props.action}
    </div>
  );
}

export function ErrorBox(props: { error: unknown; retry?: () => void; what?: string }) {
  const message = props.error instanceof Error ? props.error.message : String(props.error);
  return (
    <div className="error-box" role="alert">
      {Icon.alert}
      <div className="grow">
        <b>{props.what ?? 'Could not load this'}</b>
        <div className="muted">{message}</div>
      </div>
      {props.retry && (
        <button className="btn sm" onClick={props.retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Skeleton({ rows = 4, pad = true }: { rows?: number; pad?: boolean }) {
  return (
    <div className="stack" style={{ padding: pad ? 14 : 0, gap: 12 }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel" style={{ width: `${[92, 78, 85, 64, 88, 71][i % 6]}%` }} />
      ))}
    </div>
  );
}

/** Standard loading / error / content switch for a query. */
export function Load<T>(props: { q: { data: T | undefined; error: unknown; isPending: boolean; refetch: () => unknown }; rows?: number; what?: string; children: (data: T) => ReactNode }) {
  if (props.q.data !== undefined) return <>{props.children(props.q.data)}</>;
  if (props.q.isPending) return <Skeleton rows={props.rows} />;
  return (
    <div style={{ padding: 14 }}>
      <ErrorBox error={props.q.error} retry={() => void props.q.refetch()} what={props.what} />
    </div>
  );
}

/** How current a market figure is. Delayed is the default truth; stale is called out. */
export function Freshness(props: { asOf?: string | null; provider?: string | null; stale?: boolean; fetchedAt?: string | null }) {
  if (!props.asOf) return null;
  return (
    <span className="fresh">
      {props.stale ? <span className="chip warn">Stale</span> : <span className="chip outline">Delayed</span>}
      <span>
        Last trade {ago(props.asOf)} ({timeOnly(props.asOf)})
        {props.provider ? `, ${props.provider}` : ''}
        {props.stale && props.fetchedAt ? `. Provider unreachable; last fetched ${ago(props.fetchedAt)}` : ''}
      </span>
    </span>
  );
}

export function Seg<T extends string>(props: { value: T; options: readonly (T | { value: T; label: string })[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={props.label}>
      {props.options.map((o) => {
        const value = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? o : o.label;
        return (
          <button key={value} type="button" aria-pressed={props.value === value} onClick={() => props.onChange(value)}>
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Labelled form field. Use `group` when the control is a set of buttons: a
 * <label> would otherwise hand its whole text to the first button as its name.
 */
export function Field(props: { label: string; hint?: string; children: ReactNode; group?: boolean }) {
  const body = (
    <>
      <span>{props.label}</span>
      {props.children}
      {props.hint && <span className="hint">{props.hint}</span>}
    </>
  );
  return props.group ? <div className="field" role="group" aria-label={props.label}>{body}</div> : <label className="field">{body}</label>;
}

// ---- overlays ---------------------------------------------------------------------
function useOverlay(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button:not([data-close])');
    (first ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);
  return ref;
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; foot?: ReactNode; wide?: boolean }) {
  const ref = useOverlay(props.onClose);
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title} ref={ref} tabIndex={-1}>
        <div className="modal-head">
          <h2>{props.title}</h2>
          <button className="btn ghost icon" onClick={props.onClose} aria-label="Close" data-close>
            {Icon.close}
          </button>
        </div>
        {props.children}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer(props: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useOverlay(props.onClose);
  return createPortal(
    <>
      <div className="scrim" style={{ background: '#05090d99' }} onMouseDown={props.onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={props.title} ref={ref} tabIndex={-1}>
        <div className="modal-head">
          <h2>{props.title}</h2>
          <button className="btn ghost icon" onClick={props.onClose} aria-label="Close" data-close>
            {Icon.close}
          </button>
        </div>
        <div className="drawer-body">{props.children}</div>
      </aside>
    </>,
    document.body,
  );
}

// ---- toasts ------------------------------------------------------------------------
interface Toast { id: number; message: string; error?: boolean }
const ToastCtx = createContext<(message: string, error?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, message, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Confirm-on-second-click button for destructive actions. */
export function ConfirmButton(props: { onConfirm: () => void; label: string; className?: string; children?: ReactNode }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={armed ? 'btn sm danger' : (props.className ?? 'btn ghost icon')}
      aria-label={armed ? `Confirm: ${props.label}` : props.label}
      title={props.label}
      onClick={(e) => {
        e.stopPropagation();
        if (armed) props.onConfirm();
        setArmed(!armed);
      }}
    >
      {armed ? 'Confirm' : (props.children ?? Icon.trash)}
    </button>
  );
}
