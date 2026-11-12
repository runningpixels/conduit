import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WorkflowActionRules } from '../ipc/contracts';

const ipc = vi.hoisted(() => ({
  setWorkflowActionRules: vi.fn(),
  previewCommandRule: vi.fn(),
  suggestCommandRules: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

import { ActionRulesSection, hasPermissions } from './ActionRulesSection';
import { isSitePattern, parseSiteList } from './BrowserSitesEditor';

const rules: WorkflowActionRules = {
  allowAll: false,
  allowed: [],
  commands: { allow: ['git status'], deny: [] },
  browserSites: ['github.com'],
};

function Harness({ initial = rules, usesComputer = false }: { initial?: WorkflowActionRules; usesComputer?: boolean }) {
  const [current, setCurrent] = useState(initial);
  return (
    <ActionRulesSection
      workflowId="w1"
      steps={[]}
      usesComputer={usesComputer}
      usesBrowserAct
      rules={current}
      onRules={setCurrent}
    />
  );
}

const BOX = /One site per line/;

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  ipc.suggestCommandRules.mockResolvedValue([]);
  ipc.setWorkflowActionRules.mockImplementation(async (_id: string, next: WorkflowActionRules) => next);
  ipc.previewCommandRule.mockResolvedValue({ error: null, covers: [], doesNotCover: [] });
});

describe('site patterns', () => {
  it('takes plain hosts and *.host, nothing else', () => {
    for (const ok of ['example.com', 'GitHub.com', 'a-b.example.co.uk', 'localhost', '*.example.com', ' shop.example.org ']) {
      expect(isSitePattern(ok)).toBe(true);
    }
    for (const bad of [
      '',
      'https://example.com',
      'example.com/path',
      'example.com:8080',
      '*.com',
      '*example.com',
      'ex*ample.com',
      '-bad.com',
      'bad-.com',
      'two words.com',
      '*.',
      'example..com',
    ]) {
      expect(isSitePattern(bad)).toBe(false);
    }
  });

  it('reads one site per line, lower-cased, without blanks or repeats', () => {
    expect(parseSiteList('GitHub.com\n\n  *.example.org \r\ngithub.com\nhttps://x.com/a')).toEqual({
      sites: ['github.com', '*.example.org'],
      invalid: ['https://x.com/a'],
    });
  });
});

describe('ActionRulesSection: browser sites', () => {
  it('shows the site list with the saved sites', () => {
    render(<Harness />);
    expect(screen.getByRole('region', { name: 'Sites agents may click and type on' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: BOX })).toHaveValue('github.com');
    expect(screen.getByRole('button', { name: 'Save sites' })).toBeDisabled();
  });

  it('“Any site” saves the any-site entry and hides the list; off brings it back', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Any site' }));
    await waitFor(() =>
      expect(ipc.setWorkflowActionRules).toHaveBeenCalledWith('w1', { ...rules, browserSites: ['*', 'github.com'] }),
    );
    await waitFor(() => expect(screen.queryByRole('textbox', { name: BOX })).toBeNull());
    expect(screen.getByText(/without asking first/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Any site' }));
    await waitFor(() =>
      expect(ipc.setWorkflowActionRules).toHaveBeenLastCalledWith('w1', { ...rules, browserSites: ['github.com'] }),
    );
    expect(await screen.findByRole('textbox', { name: BOX })).toHaveValue('github.com');
  });

  it('saves the list with the other rules kept', async () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole('textbox', { name: BOX }), { target: { value: 'github.com\n*.Example.org\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save sites' }));
    await waitFor(() =>
      expect(ipc.setWorkflowActionRules).toHaveBeenCalledWith('w1', {
        ...rules,
        browserSites: ['github.com', '*.example.org'],
      }),
    );
  });

  it('points out lines that are not sites and won’t save them', () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole('textbox', { name: BOX }), { target: { value: 'https://github.com/x\nexample.com' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Not a site: “https://github.com/x”');
    expect(screen.getByRole('textbox', { name: BOX })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save sites' })).toBeDisabled();
  });

  it('keeps the sites when command rules are saved', async () => {
    render(<Harness usesComputer />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove the rule git status' }));
    await waitFor(() =>
      expect(ipc.setWorkflowActionRules).toHaveBeenCalledWith(
        'w1',
        expect.objectContaining({ browserSites: ['github.com'], commands: { allow: [], deny: [] } }),
      ),
    );
  });

  it('counts a site list as permissions worth a tab', () => {
    const none: WorkflowActionRules = { allowAll: false, allowed: [] };
    expect(hasPermissions([], false, none)).toBe(false);
    expect(hasPermissions([], false, { ...none, browserSites: ['github.com'] })).toBe(true);
  });
});
