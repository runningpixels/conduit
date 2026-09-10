# Translation glossary

Product concepts that must be rendered the *same way every time*, per locale.

These are ordinary words, not names, so they do translate — the risk is not
that they come back in English but that they come back three different ways.
"Connector" rendered as *Connector* in Settings, *Adapter* in the consent
dialog and *Erweiterung* in a toast describes three features to a reader who
has one. Names that must not translate at all live in
[`do-not-translate.txt`](./do-not-translate.txt).

Filled in wave by wave (D1). Waves 1 (de, es, fr) and 2 (ja, pt-BR) are
decided; ko and zh-CN are not.

## How the German column was decided

Not invented here — read out of the onboarding and recovery strings that were
translated and reviewed during the Phase 0 spike, so the catalog stays
internally consistent with copy that already shipped. Where the spike made no
choice, the entry says so.

| Concept | German | Spanish | French | Japanese | Portuguese (BR) | Note |
| --- | --- | --- | --- | --- | --- | --- |
| artifact | Artefakt | Artefacto | Artefact | アーティファクト | Artefato | Established: `recovery.delete.wipe.scopeConversationsLabel`. |
| connector | Connector | Conector | Connecteur | コネクタ | Conector | Kept as a loanword, capitalised as a German noun. It names a feature of this app, and *Adapter* / *Erweiterung* both already mean something else in the ecosystem. |
| chat (the stored record) | Chat | chat | conversation | チャット | chat | English said both "chat" and "conversation" for one object and now says only *chat*. The three locales split on purpose — see below. Never *Gespräch* / *charla*: the UI means the stored record, not the act of talking. |
| provider | Anbieter | Proveedor | Fournisseur | プロバイダー | Provedor | Established: `onboarding.finish.needCredential`. |
| model | Modell | Modelo | Modèle | モデル | Modelo | Established. The model *id* is data and never translates. |
| key (API key) | Schlüssel | Clave | Clé | キー | Chave | Established. `API` itself stays English. |
| keychain | Schlüsselbund | Llavero del sistema | Trousseau du système | キーチェーン | Chaveiro do sistema | Matches the OS vocabulary users already see. |
| skill | Skill | Skill | Skill | スキル | Skill | Loanword. *Fähigkeit* reads as a capability of the assistant rather than a named, installable package. |
| workspace | Arbeitsbereich | Espacio de trabajo | Espace de travail | ワークスペース | Espaço de trabalho | The bound folder. Not *Workspace*: unlike *Skill*, this one has a settled German word in developer tooling. |
| memory | Gespeicherte Fakten | Memoria | Mémoire | 記憶 | Memória | Descriptive rather than literal: *Erinnerung* reads as reminiscence, *Speicher* as disk or RAM — and `Speicher` is already the store in the recovery copy. |
| token | Token | Token | Token | トークン | Token | Loanword; the plural is *Tokens*. |
| context window | Kontextfenster | Ventana de contexto | Fenêtre de contexte | コンテキストウィンドウ | Janela de contexto | Compound, one word. |
| tool call | Tool-Aufruf | Llamada a herramienta | Appel d'outil | ツール呼び出し | Chamada de ferramenta | `Tool` is a loanword here (established in `onboarding.connectors.hint`); the action half translates. |
| consent | Zustimmung | Consentimiento | Consentement | 同意 | Consentimento | Not *Einwilligung*, which carries a legal register this UI does not mean. |
| thought | Gedanke | Pensamiento | Pensée | 思考 | Pensamento | The assistant's reasoning trace. |
| store (local data) | Speicher | Almacén local | Stockage local | ローカルデータ | Armazenamento local | Established: `recovery.actions.continueFresh`. |
| settings (the screen) | Einstellungen | Configuración | Paramètres | 設定 | Configurações | The settings sheet, and every sentence that points at it. Not French *Réglages*, which is the macOS word — this app is Windows-first and its window controls already follow Windows. |
| parameters (generation) | Modellparameter | Parámetros | Paramètres du modèle | モデルパラメーター | Parâmetros do modelo | Always qualified, so it does not collide with the screen above. |
| composer | Eingabebereich | campo de mensaje | zone de saisie | 入力エリア | campo de mensagem | The region holding the input, the Chat settings chip, the skills and search icons and the folder binding. Never the calque: `Composer` reads as *Komponist*, and *compositor* / *compositeur* are people who write music. Spanish and French both took the name from the skip link, the one place the element names itself to a screen reader. |
| sidebar | Seitenleiste | Barra lateral | Barre latérale | サイドバー | Barra lateral | The `<aside>`. The `<nav>` inside it is the chat list and is named separately — they were briefly both "Chats", which a screen reader reads as "Chats region, Chats navigation". |

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

## Why Japanese and Brazilian Portuguese diverge in turn

Wave 2 settled its terminology *before* the keys were split, which wave 1 did
not — every wave-1 locale shipped with two names for something because the
words were agreed after the split. Four rows are worth the reasoning.

- **memory — 記憶, not メモリ.** This is German's problem in a second language:
  メモリ is RAM to any Japanese reader, exactly as *Speicher* is disk to a
  German one. 記憶 is what the AI sense of the word actually is, it reads as a
  noun in *この記憶を削除しますか？* as naturally as it does in the section
  heading, and it leaves メモリ free to mean hardware if this UI ever needs it.
  Portuguese has no such collision — *Memória* is simply right, like Spanish.
- **composer — 入力エリア, not 入力欄.** The distinction matters more in
  Japanese than anywhere else, because 入力欄 is the ordinary word for a text
  input and this app has dozens of them. 入力エリア names the *region* — the
  input plus the Chat settings chip, the skills and search icons, the folder
  binding — and mirrors German's *Eingabebereich* by arriving at the same
  distinction independently. コンポーザー was rejected for the reason all four
  earlier locales rejected the calque: it is a person who writes music.
  Portuguese took *campo de mensagem* from the skip link, as Spanish did.
- **chat — チャット and *chat*, both loanwords, for opposite-looking reasons.**
  Japanese has no native short word for the stored record: 会話 is the act of
  talking (the thing the glossary has forbidden since German), and チャット is
  already what Japanese messaging UI ships. Brazilian Portuguese is the
  interesting one, because its own messaging apps say *conversa* — WhatsApp and
  Telegram both do — and it still takes *chat*. The reason is that *conversa*
  carries the same act-of-talking sense the other locales rejected, while
  *chat* is unambiguous in Brazilian software, is 4 characters against 8, and
  keeps the possessive furniture short: *Configurações do chat* against
  *Configurações da conversa*. Unlike French, there is no homograph to run
  from — *chat* means nothing else in Portuguese.
- **settings — Configurações, not Ajustes.** *Ajustes* is the European
  Portuguese and Apple word; Brazilian Windows software says *Configurações*,
  and this app is Windows-first for the same reason French rejected
  *Réglages*. Spanish made the same call and then broke it in four strings,
  which is why the settings sheet is registered in G12.

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

**Japanese** — です・ます調 throughout, and no further. Plain 敬語 (ご確認ください)
is right for a prompt addressed to the user; 尊敬語 and 謙譲語 are not, because
the app is not a service desk. Two conventions carry back most of the width
Japanese loses elsewhere: buttons and headings are 体言止め — noun phrases,
*保存* rather than *保存します* — and the subject is dropped wherever it is
recoverable, which is nearly everywhere, so *あなたの* almost never appears.
Where English hedges with "may" or "can", Japanese states the condition
instead; a literal ～かもしれません reads as the app being unsure of its own
behaviour.

**Brazilian Portuguese** — *você* implied rather than written, and impersonal
or infinitive constructions preferred, as in Spanish and for the same reasons:
*"Aplicado na próxima inicialização"* rather than *"Você aplicará isto…"*.
Buttons are infinitives (*Salvar*, *Cancelar*, *Excluir*), which is what
Brazilian software ships and what keeps them short. Never *tu*, and never the
European Portuguese vocabulary — *ecrã*, *ficheiro*, *utilizador* — which reads
as foreign in Brazil: this locale is *tela*, *arquivo*, *usuário*.

## What the machine checks, and what it cannot

`catalogs.test.ts` enforces the mechanical half: ICU parses, placeholders and
inline tags match English exactly, no `do-not-translate.txt` term is bent, no
message hardcodes the product name.

It cannot check that this table was followed — consistency of *word choice* is
what a reviewer is for, and it is the main thing to look for. Phase 5 sends
the highest-consequence screens to a native reviewer for exactly that reason:
onboarding's delete-data copy, the three consent permission levels, and the
settings validation errors.
