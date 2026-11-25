/// Renders an app's tile (the mark `AppTile` shows, on its category colour) to
/// square PNGs for the OS entries Rust writes (.ico / .icns / .png). Done in the
/// webview so emoji come out in the system emoji font, as in the tile.

import type { AppCategory, AppIconImage } from '../ipc/contracts';
import { defaultMark } from './AppTile';

/** Sizes Rust expects, in px. */
export const APP_ICON_SIZES = [16, 32, 48, 128, 256, 512] as const;

/** What the tile shows: the app's own mark, else the letters of its name. */
export function iconMark(icon: string | null | undefined, name: string): string {
  return icon?.trim() || defaultMark(name);
}

/** Corner radius for a square icon: about 22%, a little tighter when tiny. */
export function iconRadius(size: number): number {
  return size * (size <= 32 ? 0.18 : 0.22);
}

/** Font size so a mark of this many characters fills about half the tile
 *  (less for longer marks, which would overflow otherwise). */
export function markFontSize(mark: string, size: number): number {
  const length = Array.from(mark).length;
  const fraction = length <= 1 ? 0.56 : length === 2 ? 0.46 : length === 3 ? 0.34 : length === 4 ? 0.27 : 0.22;
  return Math.round(size * fraction);
}

const FALLBACK_TILE = '#4b4ded';
const MARK_COLOUR = '#fffdf8';

/** The category's tile tint: the CSS `color` of a hidden `.app-tile`. */
export function tileColour(category: AppCategory): string {
  try {
    const probe = document.createElement('span');
    probe.className = 'app-tile';
    probe.dataset.category = category;
    probe.hidden = true;
    document.body.appendChild(probe);
    // `hidden` keeps the element out of layout but the cascade still applies.
    const colour = getComputedStyle(probe).color;
    probe.remove();
    if (colour) return colour;
  } catch {
    /* fall through */
  }
  return accentColour();
}

function accentColour(): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    if (value) return value;
  } catch {
    /* fall through */
  }
  return FALLBACK_TILE;
}

function monoFamily(): string {
  let mono = '';
  try {
    mono = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
  } catch {
    /* use the fallback */
  }
  return `${mono ? `${mono}, ` : ''}ui-monospace, "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", monospace`;
}

function drawIcon(size: number, mark: string, colour: string, family: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available');
  const radius = iconRadius(size);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(0, 0, size, size, radius);
  } else {
    // Older WebKit has no roundRect.
    ctx.moveTo(radius, 0);
    ctx.arcTo(size, 0, size, size, radius);
    ctx.arcTo(size, size, 0, size, radius);
    ctx.arcTo(0, size, 0, 0, radius);
    ctx.arcTo(0, 0, size, 0, radius);
    ctx.closePath();
  }
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.fillStyle = MARK_COLOUR;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${markFontSize(mark, size)}px ${family}`;
  // Optical centring: the middle baseline sits a touch high for caps and digits.
  ctx.fillText(mark, size / 2, size / 2 + size * 0.03);
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}

export async function renderAppIconImages({
  icon,
  name,
  category,
}: {
  icon?: string | null;
  name: string;
  category: AppCategory;
}): Promise<AppIconImage[]> {
  try {
    await document.fonts?.ready;
  } catch {
    /* draw with whatever is loaded */
  }
  const mark = iconMark(icon, name);
  const colour = tileColour(category);
  const family = monoFamily();
  return APP_ICON_SIZES.map((size) => ({ size, pngBase64: drawIcon(size, mark, colour, family) }));
}
