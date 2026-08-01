/*
 * @conduit/ui — shared React primitives.
 * Token + scale driven (CSS lives in tokens.css); no hard-coded radii or
 * spacing inside. Implements the §6 primitive inventory: Button, IconButton,
 * Pill/StatusPill, Chip, SearchBox, InfoCard, SectionLabel, Avatar/Role.
 */
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from 'react';
import { useEffect, useRef, useState } from 'react';

/* ── Button ─────────────────────────────────────────────────────────────── */
export type ButtonVariant = 'default' | 'primary' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'default', className, ...rest }: ButtonProps) {
  const cls = variant === 'default' ? 'btn' : `btn ${variant}`;
  return <button className={className ? `${cls} ${className}` : cls} {...rest} />;
}

/* ── IconButton ─────────────────────────────────────────────────────────── */
export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  label: string;
}

export function IconButton({ active, label, className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={className ? `icon-btn ${className}` : 'icon-btn'}
      aria-pressed={active ? 'true' : 'false'}
      {...rest}
    />
  );
}

/* ── Pill / StatusPill ──────────────────────────────────────────────────── */
export type StatusTone = 'ok' | 'warn' | 'bad' | 'ran' | 'hold' | 'local';

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone;
  children?: ReactNode;
}

export function StatusPill({ tone, className, children, ...rest }: PillProps) {
  const cls = tone === 'ran' || tone === 'hold' || tone === 'local' ? `pill ${tone}` : `status-pill ${tone}`;
  return (
    <span className={className ? `${cls} ${className}` : cls} {...rest}>
      {children}
    </span>
  );
}

/* ── Chip ───────────────────────────────────────────────────────────────── */
export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
}

export function Chip({ className, children, ...rest }: ChipProps) {
  return (
    <span className={className ? `cu-chip ${className}` : 'cu-chip'} {...rest}>
      {children}
    </span>
  );
}

/* ── SearchBox ─────────────────────────────────────────────────────────── */
export interface SearchBoxProps extends InputHTMLAttributes<HTMLInputElement> {
  placeholder?: string;
  ariaLabel?: string;
}

export function SearchBox({ placeholder, ariaLabel, className, ...rest }: SearchBoxProps) {
  return (
    <div className={className ? `search-box ${className}` : 'search-box'}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="search"
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        {...rest}
      />
    </div>
  );
}

/* ── InfoCard ──────────────────────────────────────────────────────────── */
export interface InfoCardProps extends HTMLAttributes<HTMLDivElement> {
  title: string;
  children: ReactNode;
}

export function InfoCard({ title, className, children, ...rest }: InfoCardProps) {
  return (
    <div className={className ? `info-card ${className}` : 'info-card'} {...rest}>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

/* ── SectionLabel ───────────────────────────────────────────────────────── */
export interface SectionLabelProps extends HTMLAttributes<HTMLSpanElement> {
  left: ReactNode;
  right?: ReactNode;
}

export function SectionLabel({ left, right, className, ...rest }: SectionLabelProps) {
  return (
    <span className={className ? `section-label ${className}` : 'section-label'} {...rest}>
      <span>{left}</span>
      {right !== undefined ? <span>{right}</span> : null}
    </span>
  );
}

/* ── Avatar / Role ─────────────────────────────────────────────────────── */
export type AvatarRole = 'you' | 'bot';

export interface AvatarProps extends HTMLAttributes<HTMLDivElement> {
  role: AvatarRole;
  children?: ReactNode;
}

export function Avatar({ role, className, children, ...rest }: AvatarProps) {
  return (
    <div
      className={className ? `av-role ${role} ${className}` : `av-role ${role}`}
      {...rest}
    >
      {children ?? (role === 'you' ? 'You' : null)}
    </div>
  );
}
/* ── ConfirmDialog ─────────────────────────────────────────────────────── */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** When set, the confirm button stays disabled until the user types this phrase. */
  confirmPhrase?: string;
  /** Destructive actions require an explicit click — Enter never confirms. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmPhrase,
  destructive = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [phrase, setPhrase] = useState('');

  useEffect(() => {
    if (!open) {
      setPhrase('');
      return;
    }
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, [open, onCancel]);

  if (!open) return null;

  const phraseOk = !confirmPhrase || phrase.trim() === confirmPhrase;
  const confirmDisabled = !phraseOk;

  return (
    <div className="cu-dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <div
        ref={dialogRef}
        className="cu-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cu-dialog-title"
        aria-describedby="cu-dialog-desc"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="cu-dialog-title" className="cu-dialog-title">{title}</h2>
        <div id="cu-dialog-desc" className="cu-dialog-body">{description}</div>
        {confirmPhrase && (
          <label className="cu-dialog-phrase">
            <span>Type <kbd>{confirmPhrase}</kbd> to confirm</span>
            <input
              type="text"
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              autoComplete="off"
              aria-label={`Type ${confirmPhrase} to confirm`}
            />
          </label>
        )}
        <div className="cu-dialog-actions">
          <button ref={cancelRef} className="btn ghost" type="button" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className={`btn${destructive ? ' danger' : ' primary'}`}
            type="button"
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
