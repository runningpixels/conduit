/// What React Flow needs from a browser that jsdom lacks, per its own testing
/// guide: ResizeObserver with a size, DOMMatrixReadOnly, element sizes and
/// SVG bounding boxes. Call from a test file's `beforeAll`.

import { vi } from 'vitest';

export function installReactFlowStubs(): void {
  class ResizeObserverStub {
    constructor(private cb: ResizeObserverCallback) {}
    observe(target: Element) {
      const contentRect = { x: 0, y: 0, top: 0, left: 0, width: 900, height: 600, right: 900, bottom: 600 } as DOMRectReadOnly;
      this.cb([{ target, contentRect } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  class DOMMatrixReadOnlyStub {
    m22: number;
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([0-9.]+)\)/)?.[1];
      this.m22 = scale !== undefined ? Number(scale) : 1;
    }
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnlyStub);
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get() { return parseFloat((this as HTMLElement).style.height) || 600; } },
    offsetWidth: { configurable: true, get() { return parseFloat((this as HTMLElement).style.width) || 900; } },
  });
  (SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
}
