import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_ICON_SIZES, iconMark, iconRadius, markFontSize, renderAppIconImages } from './appIconImages';

describe('icon helpers', () => {
  it('uses the app mark, else the letters of its name (as the tile does)', () => {
    expect(iconMark('☀', 'Weather')).toBe('☀');
    expect(iconMark('  25:00 ', 'Timer')).toBe('25:00');
    expect(iconMark(undefined, 'Pomodoro timer')).toBe('Pt');
    expect(iconMark('  ', 'Weather')).toBe('We');
  });

  it('rounds corners at about 22%, tighter when tiny', () => {
    expect(iconRadius(256)).toBeCloseTo(56.32);
    expect(iconRadius(16)).toBeLessThan(16 * 0.22);
  });

  it('shrinks the font as the mark gets longer', () => {
    const one = markFontSize('A', 100);
    const two = markFontSize('AB', 100);
    const five = markFontSize('25:00', 100);
    expect(one).toBeGreaterThan(two);
    expect(two).toBeGreaterThan(five);
    expect(one).toBeLessThanOrEqual(60);
    // An emoji is one mark, however many UTF-16 units it takes.
    expect(markFontSize('🌤', 100)).toBe(one);
  });
});

describe('renderAppIconImages', () => {
  afterEach(() => vi.restoreAllMocks());

  it('draws one square PNG per size, base64 without the data: prefix', async () => {
    const sizes: number[] = [];
    const ctx = {
      beginPath: vi.fn(),
      roundRect: vi.fn(),
      fill: vi.fn(),
      fillText: vi.fn(),
      fillStyle: '',
      textAlign: '',
      textBaseline: '',
      font: '',
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (this: HTMLCanvasElement) {
      sizes.push(this.width);
      expect(this.width).toBe(this.height);
      return 'data:image/png;base64,QUJD';
    });

    const images = await renderAppIconImages({ icon: '☀', name: 'Weather', category: 'live-data' });
    expect(images.map((i) => i.size)).toEqual([...APP_ICON_SIZES]);
    expect(APP_ICON_SIZES).toEqual([16, 32, 48, 128, 256, 512]);
    expect(images.every((i) => i.pngBase64 === 'QUJD')).toBe(true);
    expect(sizes).toEqual([16, 32, 48, 128, 256, 512]);
    expect(ctx.fillText).toHaveBeenCalledWith('☀', expect.any(Number), expect.any(Number));
  });
});
