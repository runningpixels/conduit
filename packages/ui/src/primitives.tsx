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