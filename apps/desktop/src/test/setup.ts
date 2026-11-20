/// vitest global setup (M6): jsdom + @testing-library/jest-dom matchers.
import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';

// The model catalogue is a session-wide cache (lib/modelCatalog); each test
// starts from an empty one, whatever the previous test listed.
beforeEach(() => {
  (globalThis as { __resetModelCatalog?: () => void }).__resetModelCatalog?.();
});
