import { describe, expect, it } from 'vitest';
import { trayLabels } from './useTrayLabels';

describe('trayLabels', () => {
  it('reads the menu strings from the catalog; the tooltip is the app name', () => {
    const t = (id: string) => `<${id}>`;
    expect(trayLabels(t)).toEqual({ open: '<shell.tray.open>', quit: '<shell.tray.quit>', tooltip: 'Conduit' });
  });
});
