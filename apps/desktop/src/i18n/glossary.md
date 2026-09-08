# Translation glossary

Product concepts that must be rendered the *same way every time*, per locale.

These are ordinary words, not names, so they do translate — the risk is not
that they come back in English but that they come back three different ways.
"Connector" rendered as *Connector* in Settings, *Adapter* in the consent
dialog and *Erweiterung* in a toast describes three features to a reader who
has one. Names that must not translate at all live in
[`do-not-translate.txt`](./do-not-translate.txt).

Filled in wave by wave (D1). All three wave-1 locales are decided.

## How the German column was decided

Not invented here — read out of the onboarding and recovery strings that were
translated and reviewed during the Phase 0 spike, so the catalog stays
internally consistent with copy that already shipped. Where the spike made no
choice, the entry says so.

| Concept | German | Spanish | French | Note |
| --- | --- | --- | --- | --- |
| artifact | Artefakt | Artefacto | Artefact | Established: `recovery.delete.wipe.scopeConversationsLabel`. |
| connector | Connector | Conector | Connecteur | Kept as a loanword, capitalised as a German noun. It names a feature of this app, and *Adapter* / *Erweiterung* both already mean something else in the ecosystem. |
| chat (the stored record) | Chat | chat | conversation | English said both "chat" and "conversation" for one object and now says only *chat*. The three locales split on purpose — see below. Never *Gespräch* / *charla*: the UI means the stored record, not the act of talking. |
| provider | Anbieter | Proveedor | Fournisseur | Established: `onboarding.finish.needCredential`. |
| model | Modell | Modelo | Modèle | Established. The model *id* is data and never translates. |
| key (API key) | Schlüssel | Clave | Clé | Established. `API` itself stays English. |
| keychain | Schlüsselbund | Llavero del sistema | Trousseau du système | Matches the OS vocabulary users already see. |
| skill | Skill | Skill | Skill | Loanword. *Fähigkeit* reads as a capability of the assistant rather than a named, installable package. |
| workspace | Arbeitsbereich | Espacio de trabajo | Espace de travail | The bound folder. Not *Workspace*: unlike *Skill*, this one has a settled German word in developer tooling. |
| memory | Gespeicherte Fakten | Memoria | Mémoire | Descriptive rather than literal: *Erinnerung* reads as reminiscence, *Speicher* as disk or RAM — and `Speicher` is already the store in the recovery copy. |
| token | Token | Token | Token | Loanword; the plural is *Tokens*. |
| context window | Kontextfenster | Ventana de contexto | Fenêtre de contexte | Compound, one word. |
| tool call | Tool-Aufruf | Llamada a herramienta | Appel d'outil | `Tool` is a loanword here (established in `onboarding.connectors.hint`); the action half translates. |
| consent | Zustimmung | Consentimiento | Consentement | Not *Einwilligung*, which carries a legal register this UI does not mean. |
| thought | Gedanke | Pensamiento | Pensée | The assistant's reasoning trace. |
| store (local data) | Speicher | Almacén local | Stockage local | Established: `recovery.actions.continueFresh`. |
| settings (the screen) | Einstellungen | Configuración | Paramètres | The settings sheet, and every sentence that points at it. Not French *Réglages*, which is the macOS word — this app is Windows-first and its window controls already follow Windows. |
| parameters (generation) | Modellparameter | Parámetros | Paramètres du modèle | Always qualified, so it does not collide with the screen above. |
| composer | Eingabebereich | campo de mensaje | zone de saisie | The region holding the input, the Chat settings chip, the skills and search icons and the folder binding. Never the calque: `Composer` reads as *Komponist*, and *compositor* / *compositeur* are people who write music. Spanish and French both took the name from the skip link, the one place the element names itself to a screen reader. |
| sidebar | Seitenleiste | Barra lateral | Barre latérale | The `<aside>`. The `<nav>` inside it is the chat list and is named separately — they were briefly both "Chats", which a screen reader reads as "Chats region, Chats navigation". |

## Name every screen before the work is split

These four rows were all added after the fact, and the same way each time.
French came back with the settings screen called *Paramètres* in one slice and
*Réglages* in another, because the glossary covered product concepts and said
nothing about the app's own furniture — and the two translators split the work
between them before either could notice. The composer was worse: English itself
called it two things ("the composer", "the chat bar"), and underneath that
German had three names for it, Spanish five and French five.

That is cheap to fix inside one locale and expensive across seven, so anything
the copy points at *by name* belongs here before a wave starts: screens, rails,
chips, and the buttons that prose tells the user to press. Two guards in `uiCrossReferences.test.ts` enforce what can be checked
mechanically. **G12** compares a sentence against the label of the element it
names. **G13** covers the elements that have no label to compare against — the
composer is a region whose only name lives in a skip link — by pinning the word
each locale settled on, and failing when a locale has no row at all. That last
part is why the table is hard-coded rather than inferred: inferring a rendering
from the catalog can only discover what is already there, so it would bless a
split instead of catching one.

## Why French says *conversation* where German and Spanish say *Chat*

English normalised onto "chat" for the stored record. German and Spanish
followed it into the loanword; French refused, and all three were right.

- **German — *Chat*.** It is what German consumer messaging UI says (WhatsApp,
  Telegram, Teams), it is 4 characters against 12, and it was already the word
  inside every compound label the app ships (*Chat-Einstellungen*,
  *Chat-Sitzung*, *Neuer Chat*). Choosing *Unterhaltung* would have renamed
  every one of those and turned the composer chip into
  *Unterhaltungseinstellungen*. Note the gender change it forced: *die
  Unterhaltung* to *der Chat* moved articles and adjectives in about ten
  strings, not just the noun.
- **Spanish — *chat*.** Same reasoning. *El chat* is masculine and short where
  *la conversación* is twelve characters and drags agreement through 49
  strings, and the app furniture already read *barra de chat*, *sesión de
  chat*, *Ajustes del chat*.
- **French — *conversation*.** *Chat* is the French word for **cat**. The
  rename would have put a bare, unqualified *Chats* in the sidebar landmark,
  the command-palette heading and the search placeholder — exactly the places
  with no surrounding context to disambiguate it. *Conversation* is also what
  French messaging UI ships. The width cost is real (*Paramètres de la
  conversation* is 29 characters against 13) and is paid deliberately: if a
  label overflows, the fix is a shorter label, not a word that reads as an
  animal.

The lesson is the one this table exists for. A per-locale glossary is not a
translation of an English table — it is the place each language records the
constraint the others do not have.

## Why Spanish and French diverge from German in three places

- **memory** — German needed *Gespeicherte Fakten* because *Erinnerung* means
  reminiscence and *Speicher* was already the local store. Neither conflict
  exists in Spanish or French, so *Memoria* / *Mémoire* is simply right, and
  the long German compound should not be copied for symmetry's sake.
- **connector** — German keeps the loanword because *Adapter* and *Erweiterung*
  are both taken in that ecosystem. *Conector* and *Connecteur* are ordinary,
  unambiguous words in Spanish and French, so they translate.
- **tool call** — German keeps *Tool* (already established in shipped copy).
  *Herramienta* and *outil* are the natural words and carry no baggage.

*Skill* stays a loanword in all three: it names an installable package, and
*habilidad* / *compétence* would read as a capability of the assistant.

## Register

**German** — informal *du*, not *Sie*. Consumer software, and the English copy
is direct ("Drop a valid package into…"). Impersonal constructions are
preferred where they read naturally — *"Wird beim nächsten Start angewendet"*
rather than *"Sie wenden dies beim nächsten Start an"* — which is both
idiomatic and shorter, and this UI is short on width.

**Spanish** — prefer impersonal and reflexive constructions
(*"Se aplicará en el próximo inicio"*). That is house style for Spanish
software, it is shorter, and it sidesteps the *tú*/*usted* split, which is a
regional choice this product has no reason to make. Where direct address is
genuinely unavoidable, use *tú* — the register matches the English.

**French** — *vous*, which is standard in French software regardless of how
informal the English is; *tu* in an interface reads as a mistake rather than as
friendliness. Impersonal constructions where they read naturally, for the same
brevity reason as the other two.

## What the machine checks, and what it cannot

`catalogs.test.ts` enforces the mechanical half: ICU parses, placeholders and
inline tags match English exactly, no `do-not-translate.txt` term is bent, no
message hardcodes the product name.

It cannot check that this table was followed — consistency of *word choice* is
what a reviewer is for, and it is the main thing to look for. Phase 5 sends
the highest-consequence screens to a native reviewer for exactly that reason:
onboarding's delete-data copy, the three consent permission levels, and the
settings validation errors.
