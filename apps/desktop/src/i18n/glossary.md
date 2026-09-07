# Translation glossary

Product concepts that must be rendered the *same way every time*, per locale.

These are ordinary words, not names, so they do translate — the risk is not
that they come back in English but that they come back three different ways.
"Connector" rendered as *Connector* in Settings, *Adapter* in the consent
dialog and *Erweiterung* in a toast describes three features to a reader who
has one. Names that must not translate at all live in
[`do-not-translate.txt`](./do-not-translate.txt).

Filled in wave by wave (D1). German is decided; Spanish and French are filled
during their own wave rather than guessed at now.

## How the German column was decided

Not invented here — read out of the onboarding and recovery strings that were
translated and reviewed during the Phase 0 spike, so the catalog stays
internally consistent with copy that already shipped. Where the spike made no
choice, the entry says so.

| Concept | German | Spanish | French | Note |
| --- | --- | --- | --- | --- |
| artifact | Artefakt | — | — | Established: `recovery.delete.wipe.scopeConversationsLabel`. |
| connector | Connector | — | — | Kept as a loanword, capitalised as a German noun. It names a feature of this app, and *Adapter* / *Erweiterung* both already mean something else in the ecosystem. |
| conversation | Unterhaltung | — | — | Established: `onboarding.welcome.lede`. Not *Gespräch* — the UI means the stored record, not the act. |
| provider | Anbieter | — | — | Established: `onboarding.finish.needCredential`. |
| model | Modell | — | — | Established. The model *id* is data and never translates. |
| key (API key) | Schlüssel | — | — | Established. `API` itself stays English. |
| keychain | Schlüsselbund | — | — | Matches the OS vocabulary users already see. |
| skill | Skill | — | — | Loanword. *Fähigkeit* reads as a capability of the assistant rather than a named, installable package. |
| workspace | Arbeitsbereich | — | — | The bound folder. Not *Workspace*: unlike *Skill*, this one has a settled German word in developer tooling. |
| memory | Gespeicherte Fakten | — | — | Descriptive rather than literal: *Erinnerung* reads as reminiscence, *Speicher* as disk or RAM — and `Speicher` is already the store in the recovery copy. |
| token | Token | — | — | Loanword; the plural is *Tokens*. |
| context window | Kontextfenster | — | — | Compound, one word. |
| tool call | Tool-Aufruf | — | — | `Tool` is a loanword here (established in `onboarding.connectors.hint`); the action half translates. |
| consent | Zustimmung | — | — | Not *Einwilligung*, which carries a legal register this UI does not mean. |
| thought | Gedanke | — | — | The assistant's reasoning trace. |
| store (local data) | Speicher | — | — | Established: `recovery.actions.continueFresh`. |

## Register

Informal *du*, not *Sie*. Consumer software, and the English copy is direct
("Drop a valid package into…"). Impersonal constructions are preferred where
they read naturally — *"Wird beim nächsten Start angewendet"* rather than
*"Sie wenden dies beim nächsten Start an"* — which is both idiomatic and
shorter, and this UI is short on width.

## What the machine checks, and what it cannot

`catalogs.test.ts` enforces the mechanical half: ICU parses, placeholders and
inline tags match English exactly, no `do-not-translate.txt` term is bent, no
message hardcodes the product name.

It cannot check that this table was followed — consistency of *word choice* is
what a reviewer is for, and it is the main thing to look for. Phase 5 sends
the highest-consequence screens to a native reviewer for exactly that reason:
onboarding's delete-data copy, the three consent permission levels, and the
settings validation errors.
