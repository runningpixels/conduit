/// An app's icon: a short typographic mark (`25:00`, `Fe`, `☀`) on a tile
/// tinted by the app's category, the same language as the idea gallery.

import type { AppCategory } from '../ipc/contracts';

export const APP_CATEGORIES: readonly AppCategory[] = ['tools', 'live-data', 'learn', 'play', 'writing', 'other'];

/// The mark an app gets when the user leaves the icon empty: the first
/// letters of its first two words, or the first two of a single word.
export function defaultMark(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '·';
  const mark =
    words.length === 1
      ? Array.from(words[0]).slice(0, 2).join('')
      : Array.from(words[0])[0] + Array.from(words[1])[0];
  return mark.charAt(0).toUpperCase() + mark.slice(1);
}

const SIZE_CLASS = {
  sm: 'app-tile app-tile-sm',
  md: 'app-tile',
  lg: 'app-tile app-tile-lg',
} as const;

export function AppTile({
  icon,
  name,
  category,
  size = 'md',
}: {
  icon?: string | null;
  name: string;
  category: AppCategory;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <span className={SIZE_CLASS[size]} data-category={category} aria-hidden="true">
      {icon?.trim() || defaultMark(name)}
    </span>
  );
}
