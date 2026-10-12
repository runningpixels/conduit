/// The "runs after" graph of a workflow's top-level steps, as pure functions.
///
/// A step waits for the steps in its `after` list: step ids, or a branch's
/// arm (`"<id>.yes"` / `"<id>.no"`). Without `after` it waits for the step
/// before it (the first one waits for nothing: it starts the run); `[]` also
/// means "starts with the run". Every entry names an earlier step, so the list
/// order is always a valid run order. Steps inside a loop never have `after`.

import type { WorkflowStep } from '../ipc/contracts';

export type Arm = 'yes' | 'no';

/** An `after` entry split into the step it names and the arm, if any. */
export function parseEntry(entry: string): { id: string; arm: Arm | null } {
  if (entry.endsWith('.yes')) return { id: entry.slice(0, -4), arm: 'yes' };
  if (entry.endsWith('.no')) return { id: entry.slice(0, -3), arm: 'no' };
  return { id: entry, arm: null };
}

/** The `after` entry for a step id and an optional arm. */
export function entryFor(id: string, arm: Arm | null): string {
  return arm ? `${id}.${arm}` : id;
}

/** What the step at `index` waits for when it says nothing: the step before it. */
function defaultAfter(steps: readonly WorkflowStep[], index: number): string[] {
  return index === 0 ? [] : [steps[index - 1].id];
}

/**
 * What each top-level step waits for, as entries, by step id. Entries that name
 * a step that is not earlier in the list are dropped (the checker flags them).
 */
export function dependencies(steps: readonly WorkflowStep[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const seen = new Set<string>();
  steps.forEach((step, index) => {
    const raw = step.after ?? defaultAfter(steps, index);
    out.set(
      step.id,
      raw.filter((entry) => seen.has(parseEntry(entry).id)),
    );
    seen.add(step.id);
  });
  return out;
}

/** True when any top-level step carries an explicit `after`. */
export function hasGraph(steps: readonly WorkflowStep[]): boolean {
  return steps.some((s) => s.after !== undefined);
}

/** Every step `id` runs after, directly or not (top-level steps). */
export function ancestorsOf(steps: readonly WorkflowStep[], id: string, deps = dependencies(steps)): Set<string> {
  const found = new Set<string>();
  const visit = (current: string) => {
    for (const entry of deps.get(current) ?? []) {
      const parent = parseEntry(entry).id;
      if (found.has(parent)) continue;
      found.add(parent);
      visit(parent);
    }
  };
  visit(id);
  return found;
}

/** `steps[index]` with its `after` set to `deps`, or removed when that is what it would do anyway. */
function withAfter(steps: readonly WorkflowStep[], index: number, deps: string[]): WorkflowStep {
  const { after: _drop, ...rest } = steps[index];
  const usual = defaultAfter(steps, index);
  const same = deps.length === usual.length && deps.every((d, i) => d === usual[i]);
  return (same ? rest : { ...rest, after: deps }) as WorkflowStep;
}

/** Make the step `target` also wait for `entry` (an earlier step, or one arm of an earlier branch). */
export function addDependency(steps: readonly WorkflowStep[], target: string, entry: string): WorkflowStep[] {
  const index = steps.findIndex((s) => s.id === target);
  const source = parseEntry(entry).id;
  const sourceIndex = steps.findIndex((s) => s.id === source);
  if (index < 0 || sourceIndex < 0 || sourceIndex >= index) return [...steps];
  const current = steps[index].after ?? defaultAfter(steps, index);
  if (current.includes(entry)) return [...steps];
  return steps.map((s, i) => (i === index ? withAfter(steps, index, [...current, entry]) : s));
}

/** Make the step `target` stop waiting for `entry` (it may end up starting with the run). */
export function removeDependency(steps: readonly WorkflowStep[], target: string, entry: string): WorkflowStep[] {
  const index = steps.findIndex((s) => s.id === target);
  if (index < 0) return [...steps];
  const current = steps[index].after ?? defaultAfter(steps, index);
  if (!current.includes(entry)) return [...steps];
  return steps.map((s, i) =>
    i === index ? withAfter(steps, index, current.filter((e) => e !== entry)) : s,
  );
}

/**
 * Remove the top-level step at `index`; every step that waited for it waits for
 * what it waited for instead (arms of a deleted branch included). Without any
 * `after` this is a plain removal.
 */
export function removeTopLevel(steps: readonly WorkflowStep[], index: number): WorkflowStep[] {
  const gone = steps[index];
  const rest = steps.filter((_, i) => i !== index);
  if (!gone || !hasGraph(steps)) return rest;
  const deps = dependencies(steps);
  const goneDeps = deps.get(gone.id) ?? [];
  const rewiredIds = new Set<string>();
  const next = rest.map((step) => {
    const mine = deps.get(step.id) ?? [];
    if (!mine.some((entry) => parseEntry(entry).id === gone.id)) return step;
    const rewired: string[] = [];
    for (const entry of mine) {
      const replacements = parseEntry(entry).id === gone.id ? goneDeps : [entry];
      for (const r of replacements) if (!rewired.includes(r)) rewired.push(r);
    }
    rewiredIds.add(step.id);
    return withAfter(rest, rest.indexOf(step), rewired);
  });
  // Any other step that waited implicitly keeps waiting for the same steps: its
  // "step before it" may have changed.
  return next.map((step, i) => {
    if (rewiredIds.has(step.id) || step.after !== undefined) return step;
    const was = deps.get(step.id) ?? [];
    return withAfter(next, i, was);
  });
}
