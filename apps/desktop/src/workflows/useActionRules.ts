/// Shared reads for a workflow's permissions: its stored rules, and the rules
/// worth adding because the user approved the same kind of command by hand.
/// Suggestions the user waved off ("Not now") are remembered per workflow in
/// localStorage, so they don't come back after every run.

import { useCallback, useEffect, useState } from 'react';
import { getWorkflowActionRules, suggestCommandRules } from '../ipc/client';
import type { CommandRuleSuggestion, WorkflowActionRules } from '../ipc/contracts';

/// The workflow's stored rules (null until read, or when they can't be read) and a setter for after a save.
export function useWorkflowActionRules(workflowId: string | null, refreshKey?: unknown) {
  const [rules, setRules] = useState<WorkflowActionRules | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!workflowId) {
      setRules(null);
      return;
    }
    Promise.resolve()
      .then(() => getWorkflowActionRules(workflowId))
      .then(
        (next) => {
          if (!cancelled) setRules(next ?? null);
        },
        () => {
          // Nothing saved yet reads as the default; a failed read hides what depends on it.
          if (!cancelled) setRules(null);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [workflowId, refreshKey]);
  return [rules, setRules] as const;
}

const dismissedKey = (workflowId: string) => `conduit.wf.ruleSuggestionsDismissed.${workflowId}`;

function readDismissed(workflowId: string): string[] {
  try {
    const raw = localStorage.getItem(dismissedKey(workflowId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeDismissed(workflowId: string, rules: string[]) {
  try {
    localStorage.setItem(dismissedKey(workflowId), JSON.stringify(rules));
  } catch {
    // Storage can be unavailable; the suggestion simply comes back.
  }
}

/// Suggested allow rules for a workflow, minus the ones already allowed and the ones dismissed.
/// `key` changes when a run ends, so the list is read again.
export function useRuleSuggestions(workflowId: string | null, enabled: boolean, key: unknown, allowed: readonly string[]) {
  const [all, setAll] = useState<CommandRuleSuggestion[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    setAll([]);
    if (!workflowId || !enabled) return;
    setDismissed(readDismissed(workflowId));
    Promise.resolve()
      .then(() => suggestCommandRules(workflowId))
      .then(
        (next) => {
          if (!cancelled) setAll(Array.isArray(next) ? next : []);
        },
        () => {},
      );
    return () => {
      cancelled = true;
    };
  }, [workflowId, enabled, key]);
  const dismiss = useCallback(
    (rules: readonly string[]) => {
      if (!workflowId) return;
      const next = Array.from(new Set([...readDismissed(workflowId), ...rules]));
      writeDismissed(workflowId, next);
      setDismissed(next);
    },
    [workflowId],
  );
  const suggestions = all.filter((s) => !dismissed.includes(s.rule) && !allowed.includes(s.rule));
  return { suggestions, dismiss };
}

/// Saves `rules` with `add` appended to the allow list (the deny list and the rest are kept).
export function withAllowed(rules: WorkflowActionRules, add: readonly string[]): WorkflowActionRules {
  const commands = rules.commands ?? { allow: [], deny: [] };
  return { ...rules, commands: { ...commands, allow: [...commands.allow, ...add.filter((r) => !commands.allow.includes(r))] } };
}
