import { describe, expect, it } from 'vitest';
import { trayLabels } from './useTrayLabels';

describe('trayLabels', () => {
  const t = (id: string, values?: Record<string, unknown>) =>
    values ? `<${id}:${JSON.stringify(values)}>` : `<${id}>`;

  it('reads the strings from the catalog; the tooltip is the app name', () => {
    const labels = trayLabels(t, 0);
    expect(labels).toMatchObject({
      open: '<shell.tray.open>',
      quit: '<shell.tray.quit>',
      tooltip: 'Conduit',
      stopAll: '<shell.tray.stopAll>',
      confirmQuit: '<shell.tray.confirmQuit>',
      confirmCancel: '<shell.tray.confirmCancel>',
    });
  });

  it('formats the counted strings for the count it is sent with', () => {
    expect(trayLabels(t, 0)).toMatchObject({ count: 0, running: '', confirmBody: '' });
    expect(trayLabels(t, 2)).toMatchObject({
      count: 2,
      running: '<shell.tray.running:{"count":2}>',
      confirmBody: '<shell.tray.confirmBody:{"count":2}>',
    });
  });
});
