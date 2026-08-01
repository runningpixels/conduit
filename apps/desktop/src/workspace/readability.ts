const FS_SCALE_KEY = 'conduit:v5-fs-scale';
const DENSITY_KEY = 'conduit:v5-density';

export type UiFontSize = 'compact' | 'default' | 'comfortable';
export type UiDensity = 'default' | 'compact';

const FS_SCALE: Record<UiFontSize, string> = {
  compact: '0.93',
  default: '1',
  comfortable: '1.11',
};

export function readUiFontSize(): UiFontSize {
  try {
    const v = localStorage.getItem(FS_SCALE_KEY);
    if (v === 'compact' || v === 'comfortable' || v === 'default') return v;
  } catch {
    /* ignore */
  }
  return 'default';
}

export function readUiDensity(): UiDensity {
  try {
    return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'default';
  } catch {
    return 'default';
  }
}

export function applyUiReadability(fontSize: UiFontSize, density: UiDensity): void {
  document.documentElement.style.setProperty('--fs-scale', FS_SCALE[fontSize]);
  document.documentElement.setAttribute('data-density', density);
  try {
    localStorage.setItem(FS_SCALE_KEY, fontSize);
    localStorage.setItem(DENSITY_KEY, density);
  } catch {
    /* ignore */
  }
}
