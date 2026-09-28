# Documents control (t1-8 P2)

**Card:** t1-8 P2 on the feature queue
(`conduit-docs-archive/docs/plans/feature-queue.md`). The card's own plan is
`feature-queue/t1-8-knowledge-ui-promotion.md` § "P2 implementation plan
(2026-09-23)". This is the plan of record for building it. It was re-surveyed
against `main` @ `c6b881b` (v0.1.0-rc.8, after the UI revamp) on 2026-09-27.

**Status:** built and verified on `feat/documents-control` (2026-09-27). See
"Verification" below.

## Why this card, and why now

The board has one card **In Progress** (t1-8 P2) and one at the top of
**Ready** (t2-7 secret scanner). An in-progress card finishes before a new one
starts. P2 is also what makes Documents, now a permanent destination on the
rail, worth using day to day. Today it is all-or-nothing per collection. You
can't leave out the two stale files, and you can't say "answer from *this*
file".

## What the user gets

1. **Leave a document out of a chat without deleting it.** In the composer's
   Documents popover, an attached collection expands into its documents with
   checkboxes. The row says "5 of 7 documents".
2. **`#` to point at a document for one message.** Type `#`, pick
   `notes.md · Research`, and that message searches only the documents you
   picked, even ones from collections the chat hasn't attached. Each
   reference is a chip that names its collection, and the sent message keeps
   showing what it referenced.
3. **Dropping a file on the message box attaches it on Windows.** Everywhere
   else on the window, a drop still goes to Documents.

A user with no collections sees none of this: no button, no `#` picker, no
cost per message. That is t1-6 criterion 13, the composer half, which the P1
override kept.

## Decisions

Each decision records the options that lost, so nobody re-opens them by
accident.

**D1. Exclusions, not inclusions (M2).** Store the documents a chat leaves
out. A document imported later into an attached collection is searched by
default, because that's what attaching a collection means. An inclusion list
would quietly leave new documents out. (Same as the card.)

**D2. Toggle one document at a time, not replace the set.** The API is
`set_conversation_document_excluded(conversation_id, document_id, excluded)`
rather than the card's full-set replace. Two quick clicks with an optimistic
UI would race under a full replace, where the second write could restore the
first. A toggle is idempotent. The listing command returns the canonical set
so the UI can reconcile.

**D3. Validate that the document exists, not that its collection is
attached.** The card had Rust reject ids outside attached collections, but the
card also says detaching a collection keeps its exclusions so re-attaching
restores them. Those two rules conflict. The foreign keys plus `ON DELETE
CASCADE` already prevent orphan rows, so "the document exists" is enough.

**D4. Filters go through `json_each`, not `IN (?, ?, …)`.** A collection can
hold thousands of documents. One `json_each(?)` parameter per filter keeps us
far below SQLite's variable limit and needs no cap.

**D5. A group with nothing left to search is skipped before embedding.** If
the filters leave an embedding group with no documents, it pays for no query
embedding and isn't reported as unavailable, because nothing is wrong with it.

**D6. A `#` reference narrows retrieval, and naming a document outranks
excluding it.** With references, only those documents are searched (Open
WebUI and Cursor semantics). They can come from unattached collections, and
they are searched even if the chat excludes them. Without references, D1
applies unchanged. (Same as the card.)

**D7. References are chips, not inline tokens.** A plain textarea can't hold
an atomic token, and parsing `#Title` back out at send time breaks on renames,
duplicate titles and edits. (Same as the card.)

**D8. References are stored on the user message as a new message-part kind,
`knowledgeReference`.** The card said "store on the user message" and left
open how. Attachments already work this way: `attachmentReference` parts
persist with the message and hydration reads them back. So references need
no new table and no new command:
- **Where they live:** the part's `metadata` holds `{ documentId, title,
  collectionId, collectionName }`. The title is copied so a reference to a
  since-deleted document still reads right.
- **Survival:** they survive reload, retry, edit-and-resend and fork, because
  those all read the turn's parts.
- **Providers:** the part is never sent to a provider. The normaliser drops
  it the same way it keeps only what each provider accepts.

**D9. Retry, edit and fork reuse the stored references.** `commitMessageEdit`
already carries `editedTurn.attachments` through `HandleSendOverride`, and
references ride the same way.
- The scout found that MCP resources (t0-9) are **dropped** on
  retry/edit/fork, because they're cleared after the send and never stored.
  That is a t0-9 bug. It is recorded as a follow-up, not copied here and not
  fixed in this card, because resource text is gated separately (128 KiB caps
  and reinjection checks) and should be designed on its own.

**D10. Every document is shown in the picker.** The card wanted collections
that can't be searched (no consent, no model) shown disabled with the reason.
The renderer doesn't know consent state per provider without new IPC, and
Rust already refuses those collections and names them in
`unavailableCollections`. So the picker lists every document, and a
reference whose collection can't be searched gets the existing "couldn't
search" notice naming it. **Revisit if** users pick documents that then
silently fail. The notice makes that unlikely, but it's the check.

**D11. The `#` trigger rules** (a pure function, unit-tested):
- It opens on `#` at the start of the text or after whitespace, and the query
  runs to the caret with no whitespace in it.
- It is not active inside a fenced code block or inline code, on `#` in the
  middle of a word or URL (`a#b`, `http://x/#y`), on `##`, or while an IME is
  composing.
- A Markdown heading (`# `) closes it at the space, and Enter can't pick an
  empty query into a heading.
- ↑/↓ move, Enter/Tab pick, Esc closes and leaves the text as typed.

**D12. The composer's Enter guards against IME composition.** The scout found
`Composer.handleKeyDown` has no `isComposing` check, so the Enter that confirms
a Japanese, Korean or Chinese conversion sends the message. That's a shipped
bug, and the `#` picker's Enter needs the same guard, so it's fixed here (the
same check as `useHotkeys.ts`).

**D13. Windows drop: route natively, and let Rust read only paths it saw
dropped.**
- Per Tauri's docs, with the native drop handler on (the default,
  `dragDropEnabled` unset), WebView2 doesn't deliver HTML5 `drop` events. So
  `Composer`'s `dataTransfer` handler can't fire on Windows, and
  `useKnowledgeDrop` ignores drops on the message box. Nobody has confirmed
  this on a real drag (test plan L4 is open), and a synthetic event can't
  prove it either way. So the fix doesn't depend on the answer: message-box
  drops move onto the native event too. The HTML5 handler stays for
  macOS/Linux, and whichever fires first wins for one drop.
- `useKnowledgeDrop` becomes one window drop router. Drops on `.composer`
  attach, and drops anywhere else go to Documents (as today).
- The native event carries **paths**, and `save_attachment` takes bytes. A
  command that reads any path the renderer names would be a
  read-any-file-on-disk primitive. So Rust records the paths of each native
  `Drop` in `on_window_event`, and `save_dropped_attachment(path)` accepts only
  a path from a drop in the last 60 seconds, once. It applies the same MIME
  sniffing and size cap as `save_attachment`.
- The same guard for `import_knowledge_document`, which also takes a path from
  the renderer, is noted as a follow-up and not changed here. Its
  picker-dialog path needs a separate grant, and the main webview only loads
  our own code.

**D14. Citations name their collection.** `KnowledgeCitation` gains
`collectionId` and `collectionName`, joined where citations are built, so a
citation under a reply says which `notes.md` it means.

**D15. One PR, committed by layer.** The card said one PR per milestone. The
three milestones share the composer, the retrieval path and one migration, and
we ship by tag rather than by PR, so they land as one PR. It was built by two
agents in parallel, one on Rust and one on the renderer, across all three
milestones. So the commits split by layer (backend, renderer, docs), each one
green, not one commit per milestone.

## Milestones

### M1 — the window drop router (D13)
- Rust: record native drop paths (`AppState.recent_drops`), add
  `save_dropped_attachment(path) -> Attachment` sharing `save_attachment`'s
  checks, and register it in `main.rs`.
- Renderer: `useKnowledgeDrop` → a window drop router that takes
  `onComposerDrop(paths)`. `Composer`/`ChatView` add the saved attachment the
  way `uploadAttachment` does. Stop a double-add when HTML5 `drop` also fires
  (macOS).
- Tests:
  - Rust: an unrecorded path is refused, a recorded path is accepted once,
    and a stale one expires.
  - Vitest: a composer drop never reaches Documents, and a thread drop never
    attaches.

### M2 — leave documents out (D1–D5)
- Migration `0019_conversation_excluded_documents.sql`:
  `(conversation_id, document_id)`, composite PK, `ON DELETE CASCADE` on both
  foreign keys, indexed on `conversation_id`.
- Repository: `list_excluded_documents`, `set_document_excluded`.
- Commands: `list_conversation_excluded_documents`,
  `set_conversation_document_excluded` (registered in `main.rs`).
- Search: `DocumentFilter { only: Option<Vec<String>>, exclude: Vec<String> }`
  threaded through `hybrid_search` → `vector_search`/`keyword_search` →
  `list_chunk_vectors`/`keyword_match`, via `json_each` (D4). Also a
  `group_has_searchable_documents` check (D5).
- UI: `ComposerCollections` rows for attached collections expand to list
  their documents with checkboxes, showing "n of m documents" when some are
  left out. Optimistic update with undo on failure, like
  `handleToggleCollection`. Detaching keeps the exclusions.
- Tests:
  - Repository round-trip, and a cascade when a document is deleted.
  - A rare token (`ZQXW9981`, as in t1-6) in an excluded document no longer
    ranks.
  - An all-excluded group makes no embedding call.
  - `ComposerCollections` component tests (it has none today).

### M3 — `#` references (D6–D12, D14)
- Rust:
  - `retrieve_knowledge_context(conversation_id, query, document_ids?)`: with
    ids, the collections come from the documents and the filter is
    `only = ids`.
  - `MessagePartKind::KnowledgeReference` (`knowledgeReference`) in
    provider-core, the repository mapping and export. The normaliser drops it.
  - Citation collection fields (D14).
- Renderer:
  - `findHashTrigger(text, caret)` (D11) and a `ComposerDocumentPicker`
    popover.
  - Reference chips in `ComposerContextChips`.
  - `ChatTurn.knowledgeRefs` hydrated from the parts, shown as small chips
    on the sent user message.
  - `HandleSendOverride.knowledgeRefs` for retry/edit (D9).
  - The IME guard (D12).
- Tests:
  - The trigger function, every case in D11.
  - A referenced document from an unattached collection is searched, and an
    unreferenced attached document is not.
  - A reference overrides an exclusion.
  - The provider payload has no `knowledgeReference` part.
  - Hydration and retry keep the references.

## Acceptance (from the card, restated as checks)

1. Dropping a file on the message box attaches it, and dropping it anywhere
   else offers it to Documents. The router is live-checked over CDP. The OS
   drag itself needs a hand on Windows (D13).
2. Unchecking a document stops it appearing in answers and citations, and a
   document imported later is included by default. Checked live against a
   deterministic local embedding server.
3. `#` finds any document by title, always shows its collection, and limits
   that message's retrieval to the picked documents. The references survive
   retry and reload.
4. With no collections, the composer shows no Documents button and no `#`
   picker, and makes no knowledge call per message.
5. Checked live with no collections as well as with some.

## Live test harness

The live checks need embeddings without a real provider key (we never use the
user's keys in tests). A scratch OpenAI-compatible server on `127.0.0.1:1234`,
standing in for LM Studio, serves `/v1/embeddings` with deterministic
hash-bag vectors. Its `/v1/chat/completions` replies with the document titles
it found in the system prompt, so the retrieval result is visible in the
reply. The active provider is switched to LM Studio for the test and back
afterwards. Test collections and chats are deleted afterwards, and the
user's own data is left untouched.

## Verification (2026-09-27)

- **Automated:**
  - Rust: 963 tests pass (conduit-desktop + provider-core), clippy clean
    with `-D warnings`.
  - Vitest: 2639 pass. `tsc -b --force` is clean.
  - Playwright: all 73 layout specs pass, including pseudo-locale overflow
    in 7 languages.
- **Live, in the real app over CDP**, against the fake Ollama in the harness
  above. The user's own collection and chats were left untouched, test data
  was deleted afterwards and settings were restored byte for byte.
  1. With DC Research attached, the answer used both of its documents and
     not the unattached DC Archive.
  2. Unchecking `tomato-notes.md` in the popover showed "1 of 2 documents",
     stored the exclusion, and the next answer used only
     `tomato-budget.md`.
  3. `#arch` → Enter referenced `archive-harvest.md · DC Archive`, from a
     collection the chat never attached. The answer used only it, the
     composer chip cleared after sending, and the sent question shows the
     reference.
  4. The reference survives a reload (hydrated from its
     `knowledgeReference` part) and edit-and-resend (the edited question
     searched only the referenced document).
  5. **Drop grant:** `save_dropped_attachment` on a path Rust never saw
     dropped was refused. A forged drop event over the composer was routed
     to attachments, not Documents, and the attachment failed for the same
     reason.
  6. **Criterion 13:** the browser build has no backend and so no
     collections. Its composer shows no Documents entry, and `#` opens
     nothing.
- **Not verifiable by script:** a real OS drag from Explorer onto the
  message box on Windows (acceptance 1). It needs a hand. See test plan L4.

## Follow-ups (not in this card)

- **The assistant's "Retry" only deletes the response.** Found during the
  live test: `onRetry` calls `handleRemoveLastAssistantTurn`, which has done
  this since the initial commit, although the button says "Retry this
  response". Retrying should re-run the turn, keeping its attachments and
  references, the way edit-and-resend does.

- MCP resources are dropped on retry/edit/fork (t0-9; see D9).
- `import_knowledge_document` accepts any renderer-supplied path; give it the
  D13 drop/picker grant.
- P3 (folder sync, per-file status) is its own card.
