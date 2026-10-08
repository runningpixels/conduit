/// A workflow changing a saved deck or draft while the app is open.
///
/// Rust emits `workflow-deck-changed` / `workflow-draft-changed` when an
/// "Update a deck / draft" step has written its changes. The app reloads the
/// document if it is open and nobody is editing it, otherwise says so and lets
/// the user choose the moment. A deck a workflow changed also gets its layout
/// checked once, the next time it is open: Rust cannot measure slides.

import { useEffect, useRef } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { listDeckSnapshots } from '../ipc/client';
import type { DeckDetail, DeckSnapshotSummary } from '../ipc/contracts';

export const DECK_CHANGED_EVENT = 'workflow-deck-changed';
export const DRAFT_CHANGED_EVENT = 'workflow-draft-changed';

/// Payload of `workflow-deck-changed` (Rust `workflows::runner`).
export interface WorkflowDeckChanged {
  deckId: string;
  workflowName: string;
  runId: string;
}

/// Payload of `workflow-draft-changed`.
export interface WorkflowDraftChanged {
  draftId: string;
  workflowName: string;
  runId: string;
}

function useTauriEvent<T>(name: string, onEvent: (payload: T) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void listen<T>(name, (e) => handler.current(e.payload)).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [name]);
}

/// Call `onDeck` / `onDraft` whenever a workflow has changed a deck or draft.
export function useWorkflowDocumentEvents(
  onDeck: (event: WorkflowDeckChanged) => void,
  onDraft: (event: WorkflowDraftChanged) => void,
) {
  useTauriEvent<WorkflowDeckChanged>(DECK_CHANGED_EVENT, onDeck);
  useTauriEvent<WorkflowDraftChanged>(DRAFT_CHANGED_EVENT, onDraft);
}

/// What to do with the open document when a workflow changed it: nothing when
/// it is not the one open, reload it, or (somebody is typing in it) leave it
/// and offer a reload.
export type DocumentUpdateAction = 'ignore' | 'reload' | 'note';

export function documentUpdateAction(open: boolean, editing: boolean): DocumentUpdateAction {
  if (!open) return 'ignore';
  return editing ? 'note' : 'reload';
}

/// The deck element the user is typing into right now (a slide text field).
/// Slides save on every edit, so only an open text field is "in progress".
export function deckEditInProgress(active: Element | null = document.activeElement): boolean {
  if (!active) return false;
  return active.closest('.deck-script-editor, .deck-workspace [contenteditable="true"], .deck-workspace textarea, .deck-workspace input') != null;
}

/// Someone is writing in the draft: its editor has the focus, or an editing
/// session (typed text not yet kept as a version) is open for it.
export function draftEditInProgress(
  draftId: string,
  editedDraftId: string | null,
  active: Element | null = document.activeElement,
): boolean {
  return editedDraftId === draftId || (active?.closest('.cm-editor') ?? null) != null;
}

// ── Layout follow-up ────────────────────────────────────────────────────────

/// Rust labels the history entry a workflow's edit leaves with this prefix.
export const WORKFLOW_SNAPSHOT_PREFIX = 'Workflow: ';

const CHECKED_KEY = 'conduit.workflowLayoutChecked.';
const MAX_REMEMBERED = 20;

/// True for the AI-turn history entry a workflow's deck edit leaves.
export function isWorkflowSnapshot(snapshot: Pick<DeckSnapshotSummary, 'cause' | 'label'>): boolean {
  return snapshot.cause === 'ai-turn' && snapshot.label.startsWith(WORKFLOW_SNAPSHOT_PREFIX);
}

/// Snapshot ids whose layout was already checked for `deckId`.
export function checkedSnapshots(deckId: string): string[] {
  try {
    const raw = localStorage.getItem(CHECKED_KEY + deckId);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/// Remember that the layout of the deck as `snapshotId` left it was checked.
export function markLayoutChecked(deckId: string, snapshotId: string): void {
  try {
    const next = [snapshotId, ...checkedSnapshots(deckId).filter((id) => id !== snapshotId)].slice(0, MAX_REMEMBERED);
    localStorage.setItem(CHECKED_KEY + deckId, JSON.stringify(next));
  } catch {
    // Without storage the check may run again next time; that is harmless.
  }
}

/// The snapshot whose layout still needs checking: the newest history entry,
/// when a workflow wrote it and it has not been checked. `snapshots` is newest first.
export function pendingLayoutSnapshot(deckId: string, snapshots: readonly DeckSnapshotSummary[]): DeckSnapshotSummary | null {
  const newest = snapshots[0];
  if (!newest || !isWorkflowSnapshot(newest)) return null;
  return checkedSnapshots(deckId).includes(newest.id) ? null : newest;
}

/// Runs the layout follow-up for a deck a workflow changed: when the deck is
/// open in the studio (`active`) and its newest history entry is a workflow's
/// edit nobody has checked, `check` runs once for all its slides. Runs again
/// when the deck is reloaded (its `updatedAt` changes), but never twice for
/// the same history entry. `isBusy` holds it back while a turn is running.
export function useLayoutFollowUp(options: {
  deck: DeckDetail | null;
  active: boolean;
  isBusy: () => boolean;
  check: (deck: DeckDetail, slideIds: string[]) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const deckId = options.active ? options.deck?.id : undefined;
  const updatedAt = options.active ? options.deck?.updatedAt : undefined;
  useEffect(() => {
    const deck = latest.current.deck;
    if (!deckId || !deck || deck.id !== deckId) return;
    let cancelled = false;
    void listDeckSnapshots(deck.id)
      .then((snapshots) => {
        if (cancelled || latest.current.isBusy() || latest.current.deck?.id !== deck.id) return;
        const pending = pendingLayoutSnapshot(deck.id, snapshots);
        if (!pending) return;
        markLayoutChecked(deck.id, pending.id);
        latest.current.check(
          deck,
          deck.slides.map((slide) => slide.id),
        );
      })
      .catch(() => {
        // History is best effort; the check happens on a later open.
      });
    return () => {
      cancelled = true;
    };
  }, [deckId, updatedAt]);
}
