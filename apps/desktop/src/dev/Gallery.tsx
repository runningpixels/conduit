/**
 * `?route=gallery` — every UI surface, rendered against fixture props, for the
 * theming project's "zero visual change" contract (`docs/theming/`).
 *
 * Renders real `@conduit/ui` primitives and real app components wherever a
 * component can take fixture props standalone; where a component needs the
 * live app (IPC, App.tsx's own state graph) it is given no-op callbacks and
 * inert fixture data instead — never look-alike markup copied from its JSX.
 * The one exception is the chat "user turn", which has no extracted
 * component (`ChatView.tsx` inlines it) — that one demo reuses its real
 * classes (`turn`, `bubble`, `turn-actions`) directly, noted here so a reader
 * does not go looking for a `UserTurn` component that does not exist.
 *
 * `?route=gallery&section=<name>` renders exactly one `data-gallery-section`,
 * for a focused screenshot (`apps/desktop/visual/looks.spec.ts`). The section
 * ids are the `SECTION_IDS` below.
 *
 * DEV-only: reached only via `devRoute.ts`, which is compiled away in a
 * production build. This file and `galleryFixtures.ts` are therefore dead
 * code there too — nothing here ships.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { appName } from '../brand';
import {
  Avatar,
  Button,
  Chip,
  ConfirmDialog,
  IconButton,
  InfoCard,
  SearchBox,
  SectionLabel,
  StatusPill,
  type StatusTone,
} from '@conduit/ui';
import {
  ArchiveIcon,
  ChevronDown,
  CopyIcon,
  DownloadIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SidebarIcon,
  TrashIcon,
} from '../icons';
import { Sidebar } from '../shell/Sidebar';
import { SettingsSheet } from '../shell/SettingsSheet';
import { TitleBar } from '../shell/TitleBar';
import { StatusLine } from '../shell/StatusLine';
import { MainHead } from '../workspace/MainHead';
import { CommandPalette, type CommandPaletteConversation } from '../workspace/CommandPalette';
import { Menu } from '../workspace/Menu';
import { ToastStack } from '../workspace/ToastStack';
import { DocumentPanel } from '../workspace/DocumentPanel';
import { AppearanceSection } from '../workspace/settings/AppearanceSection';
import { AssistantMessage } from '../chat/AssistantMessage';
import { SuggestedPrompts } from '../chat/SuggestedPrompts';
import { Composer } from '../chat/Composer';
import { ComposerModelPicker, type ComposerModelPickerHandle } from '../chat/ComposerModelPicker';
import {
  GALLERY_ARTIFACTS,
  GALLERY_ASSISTANT_ARTIFACT,
  GALLERY_ASSISTANT_ASK_USER,
  GALLERY_ASSISTANT_MARKDOWN,
  GALLERY_ASSISTANT_REASONING,
  GALLERY_ASSISTANT_SEARCH,
  GALLERY_ASSISTANT_STREAMING,
  GALLERY_ASSISTANT_TOOL_ERROR,
  GALLERY_ASSISTANT_TOOL_SUCCESS,
  GALLERY_CODE_ARTIFACT,
  GALLERY_CONVERSATIONS,
  GALLERY_CONVO_PROVIDERS,
  GALLERY_FOLDERS,
  GALLERY_HTML_ARTIFACT,
  GALLERY_MARKDOWN_ARTIFACT,
  GALLERY_SETTINGS,
  GALLERY_SKILLS,
  GALLERY_SUGGESTED_PROMPTS,
  GALLERY_TOASTS,
} from './galleryFixtures';
import './gallery.css';

const noop = () => {};
const asyncNoop = async () => {};

export const SECTION_IDS = [
  'primitives',
  'sidebar',
  'chat',
  'composer',
  'overlays',
  'settings',
  'document-panel',
  'status',
] as const;
export type GallerySectionId = (typeof SECTION_IDS)[number];

function readRequestedSection(): GallerySectionId | null {
  try {
    const raw = new URLSearchParams(window.location.search).get('section');
    return (SECTION_IDS as readonly string[]).includes(raw ?? '') ? (raw as GallerySectionId) : null;
  } catch {
    return null;
  }
}

/**
 * Bounds a demo: `contain: layout` (gallery.css) makes this box the
 * containing block for any `position: fixed` / `position: absolute`
 * descendant, exactly as a real ancestor with a CSS transform/filter would.
 * That is what lets a modal scrim, a menu or a toast stack render "in place"
 * on a long gallery page instead of covering the whole viewport, with no
 * change to the component itself.
 */
function GalleryFrame({ height, children }: { height: number; children: ReactNode }) {
  return (
    <div className="gallery-frame" style={{ height }}>
      {children}
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="gallery-h2">{children}</h2>;
}

function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="gallery-h3">{children}</h3>;
}

/* ── 1. primitives ─────────────────────────────────────────────────────── */

const STATUS_TONES: StatusTone[] = ['ok', 'warn', 'bad', 'ran', 'hold', 'local'];

function PrimitivesSection() {
  return (
    <>
      <SubHeading>Buttons</SubHeading>
      <div className="gallery-row">
        <Button type="button">Default</Button>
        <Button type="button" variant="primary">Primary</Button>
        <Button type="button" variant="ghost">Ghost</Button>
        <Button type="button" className="danger">Danger</Button>
        <Button type="button" disabled>Disabled</Button>
      </div>

      <SubHeading>Icon buttons</SubHeading>
      <div className="gallery-row">
        <IconButton label="Toggle sidebar"><SidebarIcon /></IconButton>
        <IconButton label="Settings" active><SettingsIcon /></IconButton>
        <IconButton label="Search"><SearchIcon /></IconButton>
        <IconButton label="Delete"><TrashIcon /></IconButton>
      </div>

      <SubHeading>Status pills</SubHeading>
      <div className="gallery-row">
        {STATUS_TONES.map((tone) => (
          <StatusPill key={tone} tone={tone}>{tone}</StatusPill>
        ))}
      </div>

      <SubHeading>Chips, search, avatars</SubHeading>
      <div className="gallery-row">
        <Chip>anthropic</Chip>
        <Chip>openai</Chip>
        <Avatar role="you" />
        <Avatar role="bot">C</Avatar>
      </div>
      <div className="gallery-row">
        <SearchBox placeholder="Search conversations…" defaultValue="" />
      </div>

      <SubHeading>Info card &amp; section label</SubHeading>
      <div className="gallery-row">
        <InfoCard title="Local-only">Nothing leaves this machine while local-only is on.</InfoCard>
      </div>
      <SectionLabel left="Providers" right="3" />

      <SubHeading>Native form controls</SubHeading>
      <div className="gallery-row gallery-form-row">
        <label className="field">
          <span className="field-label">Palette</span>
          <select defaultValue="orange-charcoal">
            <option value="orange-charcoal">Orange Charcoal</option>
            <option value="orange-dark">Orange Dark</option>
            <option value="terra">Terra</option>
          </select>
        </label>
        <label className="check-row">
          <input type="checkbox" defaultChecked />
          Styled artifact previews
        </label>
        <button className="toggle" type="button" role="switch" aria-pressed="true" aria-label="On" />
        <button className="toggle" type="button" role="switch" aria-pressed="false" aria-label="Off" />
      </div>
      <div className="gallery-row">
        <textarea
          className="composer-textarea gallery-textarea"
          defaultValue="Native textarea, styled the way the composer's is."
          rows={2}
        />
      </div>
    </>
  );
}

/* ── 2. sidebar ────────────────────────────────────────────────────────── */

function SidebarSection() {
  return (
    <GalleryFrame height={640}>
      <Sidebar
        conversations={GALLERY_CONVERSATIONS}
        folders={GALLERY_FOLDERS}
        activeConversationId="convo-active"
        convoProviders={GALLERY_CONVO_PROVIDERS}
        workspaceLabel="conduit/apps/desktop"
        localOnly
        providerCount={3}
        connectorCount={2}
        onSelectConversation={noop}
        onNewChat={noop}
        onOpenPalette={noop}
        onCollapse={noop}
        onRevealWorkspace={noop}
        onOpenSettings={noop}
        onExportDiagnostics={noop}
        onDeleteConversation={noop}
        onRenameConversation={noop}
        onDeleteAllHistory={noop}
        onPinConversation={noop}
        onArchiveConversation={noop}
        onSetConversationFolder={noop}
        onCreateFolder={undefined}
        onRenameFolder={noop}
        onDeleteFolder={noop}
      />
    </GalleryFrame>
  );
}

/* ── 3. chat ───────────────────────────────────────────────────────────── */

function ChatSection() {
  return (
    <div className="thread gallery-thread">
      <div className="thread-inner">
        <article className="turn user" data-message-id="gallery-user-turn">
          <div className="bubble">
            <p>Can you review the migration plan and flag anything risky before we ship it?</p>
          </div>
          <div className="turn-actions" style={{ opacity: 1, pointerEvents: 'auto' }}>
            <button type="button" className="act">
              <PencilIcon />
              Edit
            </button>
            <button type="button" className="act">
              <CopyIcon />
              Copy
            </button>
          </div>
        </article>

        <SubHeading>Markdown (headings, list, table, code, links, KaTeX, mermaid)</SubHeading>
        <AssistantMessage state={GALLERY_ASSISTANT_MARKDOWN} provider="anthropic" modelId="claude-sonnet-4" showModelLine />

        <SubHeading>Streaming, caret visible</SubHeading>
        <AssistantMessage state={GALLERY_ASSISTANT_STREAMING} provider="anthropic" modelId="claude-sonnet-4" showModelLine={false} />

        <SubHeading>Reasoning block</SubHeading>
        <AssistantMessage state={GALLERY_ASSISTANT_REASONING} provider="openai" modelId="gpt-4.1" showModelLine />

        <SubHeading>Tool call — success</SubHeading>
        <AssistantMessage state={GALLERY_ASSISTANT_TOOL_SUCCESS} provider="anthropic" modelId="claude-sonnet-4" showModelLine={false} conversationId="gallery" />

        <SubHeading>Tool call — error</SubHeading>
        <AssistantMessage state={GALLERY_ASSISTANT_TOOL_ERROR} provider="anthropic" modelId="claude-sonnet-4" showModelLine={false} conversationId="gallery" />

        <SubHeading>Search call</SubHeading>
        <AssistantMessage state={GALLERY_ASSISTANT_SEARCH} provider="anthropic" modelId="claude-sonnet-4" showModelLine={false} />

        <SubHeading>Artifact result card</SubHeading>
        <AssistantMessage
          state={GALLERY_ASSISTANT_ARTIFACT}
          provider="anthropic"
          modelId="claude-sonnet-4"
          showModelLine={false}
          messageId="gallery-artifact-turn"
          artifacts={GALLERY_ARTIFACTS}
          onOpenArtifact={noop}
        />

        <SubHeading>Ask-user block</SubHeading>
        <AssistantMessage state={GALLERY_ASSISTANT_ASK_USER} provider="anthropic" modelId="claude-sonnet-4" showModelLine={false} />

        <SubHeading>Suggested prompts / empty state</SubHeading>
        <SuggestedPrompts prompts={GALLERY_SUGGESTED_PROMPTS} onSelect={noop} />
      </div>
    </div>
  );
}

/* ── 4. composer ───────────────────────────────────────────────────────── */

function ComposerOpenPicker() {
  const ref = useRef<ComposerModelPickerHandle>(null);
  useEffect(() => {
    ref.current?.open();
  }, []);
  return (
    <GalleryFrame height={360}>
      <div className="composer-wrap gallery-composer-anchor">
        <ComposerModelPicker ref={ref} settings={GALLERY_SETTINGS} onSelectModel={noop} />
      </div>
    </GalleryFrame>
  );
}

function ComposerSection() {
  const [prompt, setPrompt] = useState('Summarize the changes on this branch.');
  return (
    <>
      <SubHeading>Model picker closed</SubHeading>
      <div className="composer-wrap">
        <Composer
          settings={GALLERY_SETTINGS}
          onSelectModel={noop}
          conversationId="convo-active"
          prompt={prompt}
          onPromptChange={setPrompt}
          onSend={noop}
          onStop={noop}
          streaming={false}
          webSearchOn={false}
          onWebSearchToggle={noop}
          skills={GALLERY_SKILLS}
          enabledSkillIds={[GALLERY_SKILLS[0].id]}
          usage={{ inputTokens: 2400n, outputTokens: 640n }}
          contextTokens={5200}
        />
      </div>

      <SubHeading>Model picker open</SubHeading>
      <ComposerOpenPicker />
    </>
  );
}

/* ── 5. overlays ───────────────────────────────────────────────────────── */

const PALETTE_CONVERSATIONS: CommandPaletteConversation[] = GALLERY_CONVERSATIONS.map((c) => ({
  id: c.id,
  title: c.displayTitle,
  pinned: Boolean(c.pinnedAt),
  archived: Boolean(c.archivedAt),
}));

function MenuDemo() {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <GalleryFrame height={260}>
      <button ref={triggerRef} type="button" className="btn gallery-menu-trigger">
        Conversation actions
      </button>
      <Menu open onClose={noop} triggerRef={triggerRef} className="menu" label="Conversation actions" anchorPoint={{ x: 24, y: 56 }}>
        <button className="menu-item" type="button" role="menuitem">
          <PencilIcon />
          Rename
        </button>
        <button className="menu-item" type="button" role="menuitem">
          <ArchiveIcon />
          Archive
        </button>
        <div className="menu-sep" />
        <button className="menu-item danger" type="button" role="menuitem">
          <TrashIcon />
          Delete
        </button>
      </Menu>
    </GalleryFrame>
  );
}

function OverlaysSection() {
  return (
    <>
      <SubHeading>Command palette</SubHeading>
      <GalleryFrame height={480}>
        <CommandPalette
          open
          onClose={noop}
          onNewChat={noop}
          onOpenSettings={noop}
          onToggleTheme={noop}
          onOpenShortcuts={noop}
          onToggleDocPanel={noop}
          onToggleArtifactExpand={noop}
          onToggleSidebar={noop}
          onToggleWebSearch={noop}
          onForkConversationHere={noop}
          onEditLastUserMessage={noop}
          onOpenChatSettings={noop}
          onRenameChat={noop}
          onPinChat={noop}
          onArchiveChat={noop}
          onExportDiagnostics={noop}
          onCopyConversationAsMarkdown={noop}
          onExportConversationMarkdown={noop}
          onExportConversationJson={noop}
          onDeleteChat={noop}
          onDeleteAllHistory={noop}
          onSelectModel={noop}
          conversations={PALETTE_CONVERSATIONS}
          onSelectConversation={noop}
          artifacts={GALLERY_ARTIFACTS}
          onOpenArtifact={noop}
          onSearchMessages={async () => []}
          onSelectSearchResult={noop}
        />
      </GalleryFrame>

      <SubHeading>Menu</SubHeading>
      <MenuDemo />

      <SubHeading>Confirm dialog</SubHeading>
      <GalleryFrame height={320}>
        <ConfirmDialog
          open
          title="Delete this conversation?"
          description="This removes the chat and its artifacts. This cannot be undone."
          confirmLabel="Delete"
          cancelLabel="Cancel"
          onConfirm={noop}
          onCancel={noop}
        />
      </GalleryFrame>

      <SubHeading>Toasts</SubHeading>
      <GalleryFrame height={220}>
        <ToastStack toasts={GALLERY_TOASTS} onDismiss={noop} />
      </GalleryFrame>
    </>
  );
}

/* ── 6. settings ───────────────────────────────────────────────────────── */

function SettingsSection() {
  return (
    <>
      <SubHeading>Appearance section</SubHeading>
      <div className="settings-demo">
        <AppearanceSection settings={GALLERY_SETTINGS} onUpdate={noop} />
      </div>

      <SubHeading>Settings sheet (nav + Appearance)</SubHeading>
      <GalleryFrame height={560}>
        <SettingsSheet
          open
          initialSection="appearance"
          onClose={noop}
          settings={GALLERY_SETTINGS}
          onSettingsChange={noop}
          paths={null}
          onStatus={noop}
        />
      </GalleryFrame>
    </>
  );
}

/* ── 7. document-panel ─────────────────────────────────────────────────── */

function DocumentPanelSection() {
  const fileStateMap = {
    [GALLERY_MARKDOWN_ARTIFACT.id]: 'ok' as const,
    [GALLERY_HTML_ARTIFACT.id]: 'ok' as const,
    [GALLERY_CODE_ARTIFACT.id]: 'ok' as const,
  };
  const openArtifacts = [GALLERY_MARKDOWN_ARTIFACT, GALLERY_HTML_ARTIFACT, GALLERY_CODE_ARTIFACT];
  return (
    <div className="gallery-row gallery-row-wrap">
      <div className="gallery-doc-demo">
        <SubHeading>Markdown artifact</SubHeading>
        <GalleryFrame height={520}>
          <DocumentPanel
            artifact={GALLERY_MARKDOWN_ARTIFACT}
            openArtifacts={openArtifacts}
            fileStateMap={fileStateMap}
            activeFileState="ok"
            allowlist={[]}
            docTab="preview"
            onSelectTab={noop}
            onOpenArtifact={noop}
            onSaveContent={asyncNoop}
            onExport={asyncNoop}
          />
        </GalleryFrame>
      </div>
      <div className="gallery-doc-demo">
        <SubHeading>HTML artifact</SubHeading>
        <GalleryFrame height={520}>
          <DocumentPanel
            artifact={GALLERY_HTML_ARTIFACT}
            openArtifacts={openArtifacts}
            fileStateMap={fileStateMap}
            activeFileState="ok"
            allowlist={[]}
            docTab="preview"
            onSelectTab={noop}
            onOpenArtifact={noop}
            onSaveContent={asyncNoop}
            onExport={asyncNoop}
          />
        </GalleryFrame>
      </div>
    </div>
  );
}

/* ── 8. status ─────────────────────────────────────────────────────────── */

function StatusSection() {
  return (
    <>
      <SubHeading>TitleBar</SubHeading>
      {/* Renders the caption row only — WindowControls (inside it) is a no-op
          outside Tauri (no `__TAURI_INTERNALS__`), so only the drag strip
          itself is visible here. */}
      <div className="gallery-caption-demo">
        <TitleBar />
      </div>

      <SubHeading>MainHead</SubHeading>
      <MainHead
        title="Migration plan review"
        effectiveTheme="dark"
        onToggleTheme={noop}
        panelOpen
        onTogglePanel={noop}
        hiddenArtifactCount={2}
        onToggleSidebar={noop}
        onNewChat={noop}
        onOpenPalette={noop}
        onOpenSettings={noop}
        onExportDiagnostics={noop}
        onOpenShortcuts={noop}
        providerCount={3}
        connectorCount={2}
      />

      <SubHeading>StatusLine</SubHeading>
      <div className="composer-wrap">
        <StatusLine
          settings={GALLERY_SETTINGS}
          onOpenSettings={noop}
          usage={{ inputTokens: 2400n, outputTokens: 640n }}
          contextTokens={5200}
          credentialMode="required"
          credentialRef="keychain://conduit/anthropic"
          modelMenuOpen={noop}
        />
      </div>
    </>
  );
}

/* ── page ──────────────────────────────────────────────────────────────── */

const SECTION_LABELS: Record<GallerySectionId, string> = {
  primitives: 'Primitives',
  sidebar: 'Sidebar',
  chat: 'Chat',
  composer: 'Composer',
  overlays: 'Overlays',
  settings: 'Settings',
  'document-panel': 'Document panel',
  status: 'Status',
};

const SECTION_RENDERERS: Record<GallerySectionId, () => ReactNode> = {
  primitives: () => <PrimitivesSection />,
  sidebar: () => <SidebarSection />,
  chat: () => <ChatSection />,
  composer: () => <ComposerSection />,
  overlays: () => <OverlaysSection />,
  settings: () => <SettingsSection />,
  'document-panel': () => <DocumentPanelSection />,
  status: () => <StatusSection />,
};

export default function Gallery() {
  const requested = useMemo(readRequestedSection, []);
  const sections = requested ? [requested] : SECTION_IDS;

  return (
    <div className="gallery">
      {!requested && (
        <header className="gallery-header">
          <h1 className="gallery-h1">{appName()} component gallery</h1>
          <p className="gallery-intro">
            Dev-only (<code>?route=gallery</code>). Every surface below renders real
            components against fixed fixture data, for the theming project&apos;s visual
            snapshot suite.
          </p>
        </header>
      )}
      {sections.map((id) => (
        <section key={id} className="gallery-section" data-gallery-section={id}>
          <SectionHeading>{SECTION_LABELS[id]}</SectionHeading>
          {SECTION_RENDERERS[id]()}
        </section>
      ))}
    </div>
  );
}
