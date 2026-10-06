import type { DeckStage, DraftStage, ToolDefinition } from '@conduit/config-schema';
import type { Artifact } from '../ipc/contracts';
import type { AssistantStreamState, ToolCallState } from './streamState';
import { classifyDocumentTurnIntent, type DocumentTurnIntent } from './documentTurnIntent';
import { looksLikeBrandThemeRequest } from './brandPrompt';
import { looksLikeImageGenerationRequest } from './imageGenerationPrompt';
import { defaultImageModel } from './modelGeneratesImages';
import { appName } from '../brand';
import { allowUserBranding } from '../brand/buildFlags';
import type { Translate } from '../i18n';
import { documentKindLabel } from '../lib/documentKind';
import { CONTENT_FIELD_BY_TOOL } from './documentWriteScan';

const DOCUMENT_TOOL_GROUP = 'Documents';
const BRAND_TOOL_GROUP = 'Branding';
const IMAGE_TOOL_GROUP = 'Images';
const DECK_TOOL_GROUP = 'Slides';
const DRAFT_TOOL_GROUP = 'Writing';
const RELEASE_PINNED_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Names of pinned slots you may change. Only when the user asked you to change that text.',
};

function schema(fields: Array<{ name: string; type: string; required?: boolean }>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of fields) {
    properties[field.name] = { type: field.type };
    if (field.required) required.push(field.name);
  }
  return required.length > 0
    ? { type: 'object', properties, required }
    : { type: 'object', properties };
}

/**
 * The 18-key curated brand palette surface (white-label plan §2). Kept as one
 * array so the dark/light schema halves and the actual palette object in a
 * tool call are checked against the exact same key list — a key added to one
 * and not the other is precisely the drift this mirrors against the Rust
 * side.
 */
const BRAND_PALETTE_KEYS = [
  'bg',
  'bgSide',
  'card',
  'cardHi',
  'line',
  'lineSoft',
  'lineHi',
  'ink',
  'ink2',
  'ink3',
  'hue',
  'hueText',
  'hueSolid',
  'onHue',
  'ok',
  'warn',
  'err',
  'link',
] as const;

/** One theme's worth of the brand palette: all 18 keys, all required, all strings (hex — the tool description states the grammar; JSON Schema has no regex-pattern support worth relying on here, so this is enforced by the Rust validator, not this shape). */
function brandPaletteSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const key of BRAND_PALETTE_KEYS) {
    properties[key] = { type: 'string' };
  }
  return { type: 'object', properties, required: [...BRAND_PALETTE_KEYS] };
}

/**
 * `write_brand_theme`'s input schema. Deliberately camelCase, unlike the
 * older `artifact_id`-shaped document tools: this tool's arguments
 * deserialize straight into `BrandConfig` (ts-rs-generated, camelCase) on
 * the Rust side rather than into a bespoke tool-args struct, so there is no
 * snake_case boundary to cross.
 */
function brandThemeInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      appName: { type: 'string' },
      displayName: { type: 'string' },
      tagline: { type: 'string' },
      notes: { type: 'string' },
      dark: brandPaletteSchema(),
      light: brandPaletteSchema(),
    },
    required: ['appName', 'displayName', 'dark', 'light'],
  };
}

export function builtinToolDefinitions(): ToolDefinition[] {
  return [
  {
    toolId: 'write_html_document',
    name: 'write_html_document',
    description:
      `Create a new HTML document artifact. Use only when the user explicitly asked to create HTML content. Do not use to answer capability or explanatory questions. Omit artifact_id for new documents — ${appName()} assigns IDs. After creating, revise with patch_document for targeted changes or edit_html_document to rewrite it, using the returned artifact_id; do not call write_html_document again for the same document. Give title before html so the user sees which document is being written.`,
    inputSchema: schema([
      { name: 'title', type: 'string' },
      { name: 'html', type: 'string', required: true },
      { name: 'more_to_write', type: 'boolean' },
      { name: 'artifact_id', type: 'string' },
      { name: 'filename', type: 'string' },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  {
    toolId: 'edit_html_document',
    name: 'edit_html_document',
    description:
      'Replace the full contents of an existing HTML document artifact. Use only when the user explicitly asked to revise an existing HTML document and most of it changes; for targeted changes use patch_document.',
    inputSchema: schema([
      { name: 'artifact_id', type: 'string', required: true },
      { name: 'updated_html', type: 'string', required: true },
      { name: 'more_to_write', type: 'boolean' },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  {
    toolId: 'write_markdown_document',
    name: 'write_markdown_document',
    description:
      `Create a new Markdown document artifact. Use only when the user explicitly asked to create Markdown content. Do not use to answer capability or explanatory questions. Omit artifact_id for new documents — ${appName()} assigns IDs. After creating, revise with patch_document for targeted changes or edit_markdown_document to rewrite it, using the returned artifact_id; do not call write_markdown_document again for the same document. Give title before markdown so the user sees which document is being written.`,
    inputSchema: schema([
      { name: 'title', type: 'string' },
      { name: 'markdown', type: 'string', required: true },
      { name: 'more_to_write', type: 'boolean' },
      { name: 'artifact_id', type: 'string' },
      { name: 'filename', type: 'string' },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  {
    toolId: 'edit_markdown_document',
    name: 'edit_markdown_document',
    description:
      'Replace the full contents of an existing Markdown document artifact. Use only when the user explicitly asked to revise an existing Markdown document and most of it changes; for targeted changes use patch_document.',
    inputSchema: schema([
      { name: 'artifact_id', type: 'string', required: true },
      { name: 'updated_markdown', type: 'string', required: true },
      { name: 'more_to_write', type: 'boolean' },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  {
    toolId: 'write_text_document',
    name: 'write_text_document',
    description:
      `Create a new plain-text document artifact. Use only when the user explicitly asked to create plain-text content. Do not use to answer capability or explanatory questions. Omit artifact_id for new documents — ${appName()} assigns IDs. After creating, revise with patch_document for targeted changes or edit_text_document to rewrite it, using the returned artifact_id; do not call write_text_document again for the same document. Give title before text so the user sees which document is being written.`,
    inputSchema: schema([
      { name: 'title', type: 'string' },
      { name: 'text', type: 'string', required: true },
      { name: 'more_to_write', type: 'boolean' },
      { name: 'mime_type', type: 'string' },
      { name: 'artifact_id', type: 'string' },
      { name: 'filename', type: 'string' },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  {
    toolId: 'edit_text_document',
    name: 'edit_text_document',
    description:
      'Replace the full contents of an existing plain-text document artifact. Use only when the user explicitly asked to revise an existing plain-text document and most of it changes; for targeted changes use patch_document.',
    inputSchema: schema([
      { name: 'artifact_id', type: 'string', required: true },
      { name: 'updated_text', type: 'string', required: true },
      { name: 'more_to_write', type: 'boolean' },
      { name: 'mime_type', type: 'string' },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  {
    toolId: 'patch_document',
    name: 'patch_document',
    description:
      'Change part of an existing document by exact text replacement, without rewriting the rest. Each old_text must match exactly one place in the document, as it stands after the edits before it; quote enough surrounding text to make it unique. Edits apply in order, and if any fails nothing is saved. Use it for targeted revisions, and to fill in a long document section by section after writing a skeleton with placeholder comments. Set more_to_write: true when more calls will follow in this turn.',
    inputSchema: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              old_text: { type: 'string' },
              new_text: { type: 'string' },
            },
            required: ['old_text', 'new_text'],
          },
        },
        more_to_write: { type: 'boolean' },
      },
      required: ['artifact_id', 'edits'],
    },
    permissionLevel: 'sideEffectful',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  {
    toolId: 'read_document',
    name: 'read_document',
    description:
      'Read the current content of an existing document, optionally a range of lines (1-based, inclusive). Use it before patch_document when the exact current text is not already in the conversation.',
    inputSchema: schema([
      { name: 'artifact_id', type: 'string', required: true },
      { name: 'start_line', type: 'integer' },
      { name: 'end_line', type: 'integer' },
    ]),
    permissionLevel: 'readOnly',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  {
    toolId: 'export_document',
    name: 'export_document',
    description:
      'Export an existing document artifact to disk. Use only when the user explicitly asked to export or save a document.',
    inputSchema: schema([
      { name: 'artifact_id', type: 'string', required: true },
      { name: 'include_metadata_sidecar', type: 'boolean' },
    ]),
    permissionLevel: 'sensitive',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  // ---------------------------------------------------------------------------
  // Utility tools (ReadOnly — always injected, no MCP needed)
  // ---------------------------------------------------------------------------
  {
    toolId: 'current_time',
    name: 'current_time',
    description: 'Get the current date and time in ISO-8601 format. No arguments needed.',
    inputSchema: schema([]),
    permissionLevel: 'readOnly',
    displayGroup: 'Utilities',
  },
  {
    toolId: 'uuid',
    name: 'uuid',
    description: 'Generate a new UUID v4. No arguments needed.',
    inputSchema: schema([]),
    permissionLevel: 'readOnly',
    displayGroup: 'Utilities',
  },
  {
    toolId: 'random',
    name: 'random',
    description: 'Generate a random integer in a range. Provide `min` (default 0) and `max` (default 100).',
    inputSchema: schema([
      { name: 'min', type: 'integer' },
      { name: 'max', type: 'integer' },
    ]),
    permissionLevel: 'readOnly',
    displayGroup: 'Utilities',
  },
  {
    toolId: 'calculator',
    name: 'calculator',
    description: 'Evaluate a simple arithmetic expression. Accepts `expression` (e.g. "(5 + 3) * 2"). Uses safe evaluation — no code execution.',
    inputSchema: schema([
      { name: 'expression', type: 'string', required: true },
    ]),
    permissionLevel: 'readOnly',
    displayGroup: 'Utilities',
  },
  {
    toolId: 'ask_user',
    name: 'ask_user',
    description:
      'Ask the user a short structured question mid-turn (up to 4 fields). Provide `title` and `fields` (array of {id, prompt, type: text|choice, options?}). Wait for the user\'s answers before continuing.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        fields: {
          type: 'array',
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              prompt: { type: 'string' },
              type: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'prompt', 'type'],
          },
        },
      },
      required: ['title', 'fields'],
    },
    permissionLevel: 'readOnly',
    displayGroup: 'Utilities',
  },
  {
    // t0-8 M4: `selectBuiltinImageTools` is now the selector that filters on
    // this group -- offered only when intent, provider capability, and
    // consent all hold (see `selectBuiltinTurnTools`).
    toolId: 'generate_image',
    name: 'generate_image',
    description:
      `Generate a single image from a text prompt and save it as a new image artifact. Produces exactly one image per call -- call it again for additional images. Requires the active provider to support image generation; ${appName()} returns a clear error if it doesn't.`,
    inputSchema: schema([
      { name: 'prompt', type: 'string', required: true },
      { name: 'size', type: 'string' },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: IMAGE_TOOL_GROUP,
  },
  {
    toolId: 'remember',
    name: 'remember',
    description:
      'Propose a durable personal fact for the user to save. Provide `fact` (one short sentence) and optional `kind` (`core` or `note`). The fact is queued until the user saves it in Settings → Memory; it is not used until then.',
    inputSchema: schema([
      { name: 'fact', type: 'string', required: true },
      { name: 'kind', type: 'string' },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: 'Memory',
  },
  // ---------------------------------------------------------------------------
  // Web tools (search-gated)
  // ---------------------------------------------------------------------------
  {
    toolId: 'web_search',
    name: 'web_search',
    description:
      'Search the web via the configured local search backend. Provide a `query` string. Returns up to 10 results with titles, snippets, and URLs. Empty results mean no hit — do not retry similar queries.',
    inputSchema: schema([
      { name: 'query', type: 'string', required: true },
    ]),
    permissionLevel: 'readOnly',
    displayGroup: 'Web',
  },
  {
    toolId: 'web_fetch',
    name: 'web_fetch',
    description: 'Fetch a public web page. Provide a `url` string. Returns its title and readable text (truncated at 50,000 characters). Only public https sites can be fetched; local and private-network addresses are refused.',
    inputSchema: schema([
      { name: 'url', type: 'string', required: true },
    ]),
    permissionLevel: 'readOnly',
    displayGroup: 'Web',
  },
  // ---------------------------------------------------------------------------
  // Clipboard tools
  // ---------------------------------------------------------------------------
  {
    toolId: 'clipboard_read',
    name: 'clipboard_read',
    description: 'Read the current contents of the system clipboard. Returns text content if available.',
    inputSchema: schema([]),
    permissionLevel: 'sideEffectful',
    displayGroup: 'Clipboard',
  },
  {
    toolId: 'clipboard_write',
    name: 'clipboard_write',
    description: 'Write text to the system clipboard. Provide `text` to copy.',
    inputSchema: schema([
      { name: 'text', type: 'string', required: true },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: 'Clipboard',
  },
  // ---------------------------------------------------------------------------
  // Workspace file tools (settings-gated)
  // ---------------------------------------------------------------------------
  {
    toolId: 'workspace_read',
    name: 'workspace_read',
    description:
      'Read a text file under the workspace folder. PDF and DOCX files are read as text (extracted, so offset/limit count characters for them). Path must be relative to the workspace root. Optional offset/limit in bytes for text files.',
    inputSchema: schema([
      { name: 'path', type: 'string', required: true },
      { name: 'offset', type: 'integer' },
      { name: 'limit', type: 'integer' },
    ]),
    permissionLevel: 'readOnly',
    displayGroup: 'Workspace',
  },
  {
    toolId: 'workspace_write',
    name: 'workspace_write',
    description:
      // It used to send documents to write_*_document — tools a general turn
      // is not offered. With only this one to hand, "tic tac toe" and "make
      // flashcards" were saved into the user's project folder unasked, as
      // well as shown in the reply.
      'Create or overwrite a text file under the workspace folder. Path is relative to the workspace root. Set create_dirs=true to create parent directories. Use only when the user asks to create or change a file in their project. A page, app or document the user asked to see goes in your reply, not in a file — do not also save a copy unless they ask.',
    inputSchema: schema([
      { name: 'path', type: 'string', required: true },
      { name: 'content', type: 'string', required: true },
      { name: 'create_dirs', type: 'boolean' },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: 'Workspace',
  },
  {
    toolId: 'workspace_edit',
    name: 'workspace_edit',
    description:
      'Replace the full contents of an existing text file under the workspace folder. Path is relative to the workspace root.',
    inputSchema: schema([
      { name: 'path', type: 'string', required: true },
      { name: 'content', type: 'string', required: true },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: 'Workspace',
  },
  {
    toolId: 'workspace_glob',
    name: 'workspace_glob',
    description:
      'List files under the workspace folder matching a glob pattern (relative to the workspace root), e.g. "**/*.rs".',
    inputSchema: schema([
      { name: 'pattern', type: 'string', required: true },
      { name: 'max_results', type: 'integer' },
    ]),
    permissionLevel: 'readOnly',
    displayGroup: 'Workspace',
  },
  {
    toolId: 'workspace_grep',
    name: 'workspace_grep',
    description:
      'Search file contents under the workspace folder with a regex. Optional path (subdirectory) and glob filter (e.g. "*.ts").',
    inputSchema: schema([
      { name: 'pattern', type: 'string', required: true },
      { name: 'path', type: 'string' },
      { name: 'glob', type: 'string' },
      { name: 'max_matches', type: 'integer' },
      { name: 'case_insensitive', type: 'boolean' },
    ]),
    permissionLevel: 'readOnly',
    displayGroup: 'Workspace',
  },
  // ---------------------------------------------------------------------------
  // Branding tool (white-label plan §4, Phase 4)
  // ---------------------------------------------------------------------------
  {
    toolId: 'write_brand_theme',
    name: 'write_brand_theme',
    description:
      `Propose a white-label theme for ${appName()}: a name and a full dark+light colour palette (18 keys each, hex only). This creates a reviewable Markdown artifact (brand.md) — it does not change anything in the running app by itself; the user previews or applies it explicitly from the document panel. Use only when the user explicitly asked to design, generate, or change the app's brand, theme, or colour scheme.`,
    inputSchema: brandThemeInputSchema(),
    permissionLevel: 'sideEffectful',
    displayGroup: BRAND_TOOL_GROUP,
  },
  // ---------------------------------------------------------------------------
  // Deck tools (Slides): offered only in a chat bound to a deck
  // ---------------------------------------------------------------------------
  {
    toolId: 'read_deck',
    name: 'read_deck',
    description:
      "Read the deck you are building. With no slide_id it returns the title, theme, stage, storyline and an outline of every slide (slide_id, position, layout, visible text, and its text slots with each slot's name, text and pinned flag). With a slide_id it returns that slide's full inner HTML, notes and slots. A pinned slot holds text the user wrote. Read a slide before you change it.",
    inputSchema: {
      type: 'object',
      properties: {
        slide_id: {
          type: 'string',
          description: 'Return this one slide in full instead of the deck outline.',
        },
      },
    },
    permissionLevel: 'readOnly',
    displayGroup: DECK_TOOL_GROUP,
  },
  {
    toolId: 'set_storyline',
    name: 'set_storyline',
    description:
      "Write the deck's storyline: one short line per planned slide, in order. Replaces the whole storyline. The user reviews and edits it before any slides are built. Always pass title on the first storyline (a short name for the deck, 120 characters at most). Pass assumptions when the user did not say who the deck is for or what they should do: one or two sentences stating what you assumed about audience, goal and length (400 characters at most; an empty string clears it).",
    inputSchema: {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          items: { type: 'string' },
          description: 'One short line per planned slide, in order.',
        },
        title: {
          type: 'string',
          description:
            'A short name for the deck (120 characters at most). Pass it on the first storyline; it renames the deck and its chat.',
        },
        assumptions: {
          type: 'string',
          description:
            'One or two sentences stating what you assumed about audience, goal or length that the user did not say (400 characters at most). Empty string clears it.',
        },
      },
      required: ['lines'],
    },
    permissionLevel: 'sideEffectful',
    displayGroup: DECK_TOOL_GROUP,
  },
  {
    toolId: 'add_slide',
    name: 'add_slide',
    description:
      'Add ONE slide to the deck (call once per slide), at the end or after after_slide_id. layout is a layout name from the theme (lowercase, e.g. "title"). html is the slide\'s INNER html: the app wraps it in <section class="slide" data-layout="LAYOUT">, so do not include that section yourself. Put every piece of text in an element with data-text="slot-name", style with the theme\'s classes and color tokens (never hard-coded colors), draw charts as inline SVG, and never include scripts or external URLs. notes is optional speaker notes.',
    inputSchema: {
      type: 'object',
      properties: {
        layout: {
          type: 'string',
          description: 'Layout name from the theme, lowercase letters, digits and hyphens.',
        },
        html: {
          type: 'string',
          description:
            'The slide\'s inner HTML (no outer section). Text in data-text="slot" elements; no scripts.',
        },
        notes: { type: 'string', description: 'Optional speaker notes.' },
        after_slide_id: {
          type: 'string',
          description: 'Insert after this slide; omit to append.',
        },
      },
      required: ['layout', 'html'],
    },
    permissionLevel: 'sideEffectful',
    displayGroup: DECK_TOOL_GROUP,
  },
  {
    toolId: 'update_slide',
    name: 'update_slide',
    description:
      "Replace parts of one existing slide: html (the full inner html, same rules as add_slide), layout and/or notes. Pass at least one. For a small wording change prefer patch_slide. Pinned slots (text the user wrote, data-owner=\"user\") must keep their exact content and marker: the call is rejected otherwise. Pass release_pinned with a pinned slot's name only when the user's message names that specific text (for example \"change my headline to ...\"). A request to rewrite, restyle, shorten or redo the slide or the deck does not name it: keep pinned text word for word and say in your reply that you kept it.",
    inputSchema: {
      type: 'object',
      properties: {
        slide_id: { type: 'string' },
        html: { type: 'string', description: "The slide's full new inner HTML." },
        layout: { type: 'string' },
        notes: { type: 'string' },
        release_pinned: RELEASE_PINNED_SCHEMA,
      },
      required: ['slide_id'],
    },
    permissionLevel: 'sideEffectful',
    displayGroup: DECK_TOOL_GROUP,
  },
  {
    toolId: 'patch_slide',
    name: 'patch_slide',
    description:
      "Change part of one slide's inner html by exact text replacement. Each old_text must occur exactly once in the slide; read the slide first and quote enough surrounding text. Edits apply in order, all or nothing. Pinned slots (text the user wrote, data-owner=\"user\") must keep their exact content: the call is rejected otherwise. Pass release_pinned with a pinned slot's name only when the user's message names that specific text (for example \"change my headline to ...\"). A request to rewrite, restyle, shorten or redo the slide or the deck does not name it: keep pinned text word for word and say in your reply that you kept it.",
    inputSchema: {
      type: 'object',
      properties: {
        slide_id: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              old_text: { type: 'string' },
              new_text: { type: 'string' },
            },
            required: ['old_text', 'new_text'],
          },
        },
        release_pinned: RELEASE_PINNED_SCHEMA,
      },
      required: ['slide_id', 'edits'],
    },
    permissionLevel: 'sideEffectful',
    displayGroup: DECK_TOOL_GROUP,
  },
  {
    toolId: 'move_slide',
    name: 'move_slide',
    description: 'Move a slide to a new 0-based position in the deck (clamped to the last slide).',
    inputSchema: schema([
      { name: 'slide_id', type: 'string', required: true },
      { name: 'position', type: 'integer', required: true },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: DECK_TOOL_GROUP,
  },
  {
    toolId: 'delete_slide',
    name: 'delete_slide',
    description: 'Delete one slide from the deck.',
    inputSchema: schema([{ name: 'slide_id', type: 'string', required: true }]),
    permissionLevel: 'sideEffectful',
    displayGroup: DECK_TOOL_GROUP,
  },
  {
    toolId: 'set_theme',
    name: 'set_theme',
    description:
      'Replace the deck\'s whole theme CSS (the classes and color tokens every slide uses). Rarely needed; name is the theme\'s label and defaults to "Custom".',
    inputSchema: schema([
      { name: 'css', type: 'string', required: true },
      { name: 'name', type: 'string' },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: DECK_TOOL_GROUP,
  },
  {
    toolId: 'replace_in_deck',
    name: 'replace_in_deck',
    description:
      "Swap an exact word or phrase everywhere in the deck's text and speaker notes in one step; markup is never touched. Use it only for an exact swap the user asked for across the deck. It also changes pinned slots, because the user named the word, and reports them in pinned_changed. match_case and whole_word default to false.",
    inputSchema: {
      type: 'object',
      properties: {
        find: { type: 'string', description: 'The exact word or phrase to find (200 characters at most).' },
        replace: { type: 'string', description: 'What to put in its place (200 characters at most).' },
        match_case: { type: 'boolean', description: 'Match upper and lower case exactly. Default false.' },
        whole_word: { type: 'boolean', description: 'Only match whole words. Default false.' },
      },
      required: ['find', 'replace'],
    },
    permissionLevel: 'sideEffectful',
    displayGroup: DECK_TOOL_GROUP,
  },
  {
    toolId: 'update_slots',
    name: 'update_slots',
    description:
      'Set the text of slots (elements with data-text) on one or more slides in one call. Use it for judgment edits across slides, such as sentence-casing every headline or saying customers instead of users. Each edit gives slide_id, the slot name and the new inline html: text plus only span, em, strong, b, i, u, br, sub, sup, small and mark tags, with no attributes except class. index picks one of several slots with the same name (0-based, default the first). Pinned slots (text the user wrote) are skipped and listed in skipped_pinned. For an exact word swap use replace_in_deck.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              slide_id: { type: 'string' },
              slot: { type: 'string', description: "The slot's data-text name." },
              index: { type: 'integer', description: 'Which slot with that name, 0-based. Default 0.' },
              html: { type: 'string', description: "The slot's new inline HTML." },
            },
            required: ['slide_id', 'slot', 'html'],
          },
        },
      },
      required: ['edits'],
    },
    permissionLevel: 'sideEffectful',
    displayGroup: DECK_TOOL_GROUP,
  },
  {
    toolId: 'start_deck',
    name: 'start_deck',
    description:
      'Start a slide deck from this chat. Call it when the user asks for slides, a deck or a presentation, then stop and reply in one short sentence: the app opens the deck in Slides and asks you for the storyline there. title is a short name for the deck.',
    inputSchema: schema([{ name: 'title', type: 'string', required: true }]),
    permissionLevel: 'sideEffectful',
    displayGroup: DECK_TOOL_GROUP,
  },
  // Draft tools (Writing): offered only in a draft's chat
  {
    toolId: 'read_draft',
    name: 'read_draft',
    description:
      "Read the draft you are writing. Returns the title, stage, brief, outline (heading, intent, target_words) and the draft's blocks in order, each with its id, kind, owner (ai, user or mixed), pinned flag and Markdown text. from_block and to_block (block ids, both included) read a range; without them the whole draft comes back, cut at about 60,000 characters with a note saying where to continue. A pinned block holds text the user wrote: keep it word for word.",
    inputSchema: {
      type: 'object',
      properties: {
        from_block: { type: 'string', description: 'First block id to return (default the first block).' },
        to_block: { type: 'string', description: 'Last block id to return, included (default the last block).' },
      },
    },
    permissionLevel: 'readOnly',
    displayGroup: DRAFT_TOOL_GROUP,
  },
  {
    toolId: 'set_outline',
    name: 'set_outline',
    description:
      "Propose the draft's outline: 2 to 12 sections in order, each with a heading, its intent (one sentence on what the section does for the reader) and an optional target_words. Replaces the whole outline. The user reviews and edits it, and approves it before anything is written, so stop after proposing it. Pass title with the first outline: a short name for the draft (120 characters at most).",
    inputSchema: {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string', description: "The section's heading (120 characters at most)." },
              intent: { type: 'string', description: 'What the section does for the reader, in one sentence.' },
              target_words: { type: 'integer', description: 'Planned length in words.' },
            },
            required: ['heading', 'intent'],
          },
          description: '2 to 12 sections, in order.',
        },
        title: {
          type: 'string',
          description:
            'A short name for the draft (120 characters at most). Pass it with the first outline; it renames the draft and its chat.',
        },
      },
      required: ['sections'],
    },
    permissionLevel: 'sideEffectful',
    displayGroup: DRAFT_TOOL_GROUP,
  },
  {
    toolId: 'write_section',
    name: 'write_section',
    description:
      'Write one section of the draft in Markdown. heading is the section\'s heading from the outline; markdown is the section (it may start with its "## heading" line, which is added when missing). Replaces everything under that ## heading up to the next ## heading, or adds the section where the outline puts it. Write one section per call, then stop: the result lists the sections still to write in remaining, and you will be asked for the next one. Pinned blocks (text the user wrote) inside the section must stay word for word: the call is rejected otherwise.',
    inputSchema: {
      type: 'object',
      properties: {
        heading: { type: 'string', description: "The section's heading, as in the outline." },
        markdown: { type: 'string', description: 'The section in Markdown.' },
      },
      required: ['heading', 'markdown'],
    },
    permissionLevel: 'sideEffectful',
    displayGroup: DRAFT_TOOL_GROUP,
  },
  {
    toolId: 'edit_blocks',
    name: 'edit_blocks',
    description:
      "Replace the Markdown of blocks by id: for the user's selection actions (rewrite, shorten, expand, clarify, fix grammar) and other targeted edits. Each edit gives block_id and the block's new markdown; an empty markdown deletes the block, and markdown holding several blocks splits it. Edits to pinned blocks (text the user wrote) are rejected unless their id is in release_pinned. Pass release_pinned only for blocks the user's message asks you to change, such as a selection they chose an action on; a request to rewrite or polish the whole draft does not release them.",
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              block_id: { type: 'string' },
              markdown: { type: 'string', description: "The block's new Markdown; empty deletes the block." },
            },
            required: ['block_id', 'markdown'],
          },
        },
        release_pinned: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ids of pinned blocks you may change. Only blocks the user asked you to change.',
        },
      },
      required: ['edits'],
    },
    permissionLevel: 'sideEffectful',
    displayGroup: DRAFT_TOOL_GROUP,
  },
  {
    toolId: 'replace_in_draft',
    name: 'replace_in_draft',
    description:
      'Swap an exact word or phrase everywhere in the draft in one step. Use it only for a swap the user asked for across the draft. It also changes pinned blocks, because the user named the word, and reports them in pinned_changed. match_case and whole_word default to false.',
    inputSchema: {
      type: 'object',
      properties: {
        find: { type: 'string', description: 'The exact word or phrase to find (200 characters at most).' },
        replace: { type: 'string', description: 'What to put in its place (200 characters at most).' },
        match_case: { type: 'boolean', description: 'Match upper and lower case exactly. Default false.' },
        whole_word: { type: 'boolean', description: 'Only match whole words. Default false.' },
      },
      required: ['find', 'replace'],
    },
    permissionLevel: 'sideEffectful',
    displayGroup: DRAFT_TOOL_GROUP,
  },
  ];
}

/**
 * The Documents group only.
 *
 * This was built from *every* builtin definition, so `uuid`, `calculator`,
 * `web_search` and the clipboard tools all counted as document tools. A `uuid`
 * call then rendered through `summarizeDocumentToolCall`, where the action and
 * kind lookups miss and fall through to `?? 'Document'` and the content field
 * is absent — printing "Documents / Document · Document / lines 0 / Document
 * updated." for a tool that touched no document at all.
 */
export const DOCUMENT_TOOL_NAMES = new Set(
  builtinToolDefinitions().filter((tool) => tool.displayGroup === DOCUMENT_TOOL_GROUP).map(
    (tool) => tool.name,
  ),
);

/** Document tools that create or edit content (excludes export). */
export const DOCUMENT_CONTENT_TOOL_NAMES = new Set(
  [...DOCUMENT_TOOL_NAMES].filter((name) => name !== 'export_document' && name !== 'read_document'),
);

/** `complete`: the model finished the arguments. `written`: the tool saved the document. */
export type DocumentToolPhase = 'start' | 'progress' | 'complete' | 'written' | 'error';

/** How much of a streaming document has arrived — see `documentWriteScan.ts`. */
export interface DocumentWriteProgress {
  contentChars: number;
  contentLines: number;
  /** Last time an argument fragment arrived; drives "still working". */
  lastActivityAt: number;
}

export interface DocumentToolActivity {
  phase: DocumentToolPhase;
  toolName: string;
  titleHint?: string;
  /** Present for edit_* tools once arguments are known. */
  artifactId?: string;
  /** Failure reason on `phase: 'error'`, shown in the document panel. */
  error?: string;
  /** `phase: 'progress'` only. */
  progress?: DocumentWriteProgress;
}

export function isDocumentContentTool(name: string): boolean {
  return DOCUMENT_CONTENT_TOOL_NAMES.has(name);
}

export function isDocumentCreateTool(name: string): boolean {
  return name.startsWith('write_') && DOCUMENT_CONTENT_TOOL_NAMES.has(name);
}

/** `patch_document`: a targeted change to a document that already exists. */
export function isDocumentPatchTool(name: string): boolean {
  return name === 'patch_document';
}

export function documentToolArtifactKind(toolName: string): Artifact['kind'] {
  if (toolName.includes('html')) return 'html';
  if (toolName.includes('markdown')) return 'markdown';
  if (toolName.includes('json')) return 'json';
  if (toolName.includes('code')) return 'code';
  return 'text';
}

const UTILITY_TOOL_NAMES = new Set(['current_time', 'uuid', 'random', 'calculator', 'ask_user']);
/** Utility tools a deck chat does not get: weak models wander into them
 *  mid-build (a deck build burned turns on calculator errors) and a slide never
 *  needs them. `current_time` and `ask_user` stay. */
const DECK_CHAT_OMITTED_UTILITY_TOOL_NAMES = new Set(['uuid', 'random', 'calculator']);
const WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch']);
const WORKSPACE_TOOL_GROUP = 'Workspace';

export const WORKSPACE_TOOL_NAMES = new Set(
  builtinToolDefinitions()
    .filter((tool) => tool.displayGroup === WORKSPACE_TOOL_GROUP)
    .map((tool) => tool.name),
);

/** Local `web_search` + `web_fetch` when the turn resolved to the local
 *  search backend. A hosted-search turn gets `web_fetch` alone: the hosted
 *  tool shares the `web_search` name, but without a fetch the model can find
 *  pages yet never read them. */
export function selectBuiltinWebTools(backend: 'local' | 'hosted' = 'local'): ToolDefinition[] {
  return builtinToolDefinitions().filter((t) =>
    backend === 'local' ? WEB_TOOL_NAMES.has(t.name) : t.name === 'web_fetch',
  );
}

/** Resolve the active workspace root for a turn (conversation bind wins). */
export function resolveActiveWorkspaceRoot(
  conversationRoot: string | null | undefined,
  settings: {
    workspaceToolsEnabled?: boolean;
    workspaceRoot?: string | null;
    workspaceToolsConsentAcknowledged?: boolean;
  },
): string | null {
  const fromConversation = conversationRoot?.trim() || null;
  if (fromConversation) return fromConversation;
  if (
    settings.workspaceToolsEnabled &&
    settings.workspaceToolsConsentAcknowledged &&
    settings.workspaceRoot?.trim()
  ) {
    return settings.workspaceRoot.trim();
  }
  return null;
}

/** Workspace file tools — when a conversation or settings default root is active. */
export function selectBuiltinWorkspaceTools(
  settings: {
    workspaceToolsEnabled?: boolean;
    workspaceRoot?: string | null;
    workspaceToolsConsentAcknowledged?: boolean;
  },
  conversationRoot?: string | null,
): ToolDefinition[] {
  if (!resolveActiveWorkspaceRoot(conversationRoot, settings)) {
    return [];
  }
  return builtinToolDefinitions().filter((t) => WORKSPACE_TOOL_NAMES.has(t.name));
}

/** `remember` — advertised only while Settings → Memory injection is on. */
export function selectBuiltinMemoryTools(enabled: boolean): ToolDefinition[] {
  if (!enabled) return [];
  return builtinToolDefinitions().filter((t) => t.name === 'remember');
}

/** Basename for chip display (Windows + POSIX). */
export function workspaceFolderLabel(root: string): string {
  const normalized = root.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[/\\]/);
  return parts[parts.length - 1] || root;
}

/** Offered with every document write or edit: part-by-part building and targeted revisions. */
const DOCUMENT_REVISION_TOOL_NAMES = new Set(['patch_document', 'read_document']);

/** Built-in document tools exposed to the model for a given turn intent. */
export function selectBuiltinDocumentTools(intent: DocumentTurnIntent): ToolDefinition[] {
  const utilityTools = builtinToolDefinitions().filter((t) => UTILITY_TOOL_NAMES.has(t.name));
  // Only the Documents group: the Writing tools `write_section` and
  // `edit_blocks` share the `write_`/`edit_` prefixes.
  const documentTools = builtinToolDefinitions().filter((tool) => tool.displayGroup === DOCUMENT_TOOL_GROUP);
  switch (intent) {
    case 'create':
      // Include edit_* and patch_document so mid-turn revisions use the
      // returned artifact_id instead of spawning duplicate documents via
      // another write_*, and so a long document can be built in parts.
      return [
        ...utilityTools,
        ...documentTools.filter(
          (tool) =>
            tool.name.startsWith('write_') ||
            tool.name.startsWith('edit_') ||
            DOCUMENT_REVISION_TOOL_NAMES.has(tool.name) ||
            tool.name === 'export_document',
        ),
      ];
    case 'edit':
      return [
        ...utilityTools,
        ...documentTools.filter(
          (tool) =>
            tool.name.startsWith('edit_') ||
            DOCUMENT_REVISION_TOOL_NAMES.has(tool.name) ||
            tool.name === 'export_document',
        ),
      ];
    case 'info':
    case 'general':
    default:
      return utilityTools;
  }
}

/**
 * `write_brand_theme`, gated on brand-theme intent rather than always
 * present. Its schema is much larger than any document tool's (two nested
 * 18-key objects), and unlike document creation there is no existing
 * artifact-in-scope signal to widen the gate for — so this stays a plain
 * boolean the caller computes from the prompt (`looksLikeBrandThemeRequest`,
 * `chat/brandPrompt.ts`), mirroring how `selectBuiltinDocumentTools` takes an
 * already-classified `DocumentTurnIntent` rather than classifying itself.
 *
 * Also gated on `allowUserBranding` (`brand/buildFlags.ts`), read directly
 * here rather than threaded in as a parameter, so this holds regardless of
 * what any caller passes as `brandIntent`: a Mode B build with
 * `allowUserBranding = false` can never apply a `write_brand_theme` result
 * (every persisting write refuses server-side — see
 * `commands::branding::guard_write`/`ALLOW_USER_BRANDING`), so offering the
 * tool at all would be a dead end regardless of how strong the user's intent
 * looked — the model would spend a tool call, and tokens on its ~20-key
 * schema, producing a document `DocumentPanel` cannot let the user apply
 * anyway (see its own `brandingPermitted` check).
 */
export function selectBuiltinBrandTools(brandIntent: boolean): ToolDefinition[] {
  if (!brandIntent || !allowUserBranding) return [];
  return builtinToolDefinitions().filter((tool) => tool.displayGroup === BRAND_TOOL_GROUP);
}

/**
 * `generate_image`, reachable for the first time in t0-8 M4. Offered only
 * when all three independent gates hold:
 *  1. `imageIntent` -- the turn's prompt reads like a request for an image
 *     (`looksLikeImageGenerationRequest`, `chat/imageGenerationPrompt.ts`).
 *  2. `activeProvider` resolves to a provider with image generation at all
 *     (`defaultImageModel(activeProvider) != null`).
 *  3. `consentAcknowledged` -- the user has accepted the billed/side-effectful
 *     consent dialog (`ImageGenerationConsentDialog.tsx`), mirroring
 *     `workspaceToolsConsentAcknowledged`'s shape.
 *
 * Gated on the *provider*, deliberately not on the turn's active *chat*
 * model: `modelGeneratesImages(activeProvider, activeModel)` would be false
 * for every real user, since the active model is always a chat model, never
 * an image model (`gpt-image-2.5-*` / `imagen-4.0-*` share no id namespace
 * with `gpt-4o` / `gemini-2.0-*`) -- see `image_generation.rs`'s
 * `default_image_model` doc comment and the t0-8 plan's "Tool wiring --
 * CORRECTED" section. Backward compatibility for every provider without an
 * image endpoint (Anthropic-only users included) falls out of gate 2 alone:
 * `defaultImageModel` returns `null` for them regardless of the other two
 * gates, so there is no new tool exposure, dialog, or behaviour change.
 *
 * Takes the three inputs directly rather than one pre-classified boolean
 * (contrast `selectBuiltinBrandTools`): unlike brand-theme intent, there is
 * no single upstream classification step shared by all three checks here --
 * `selectBuiltinTurnTools` computes each independently and passes them in.
 */
export function selectBuiltinImageTools(
  imageIntent: boolean,
  activeProvider: string | undefined,
  consentAcknowledged: boolean | undefined,
): ToolDefinition[] {
  if (!imageIntent || !consentAcknowledged) return [];
  if (!activeProvider || defaultImageModel(activeProvider) == null) return [];
  return builtinToolDefinitions().filter((tool) => tool.displayGroup === IMAGE_TOOL_GROUP);
}

/** `start_deck` is in the Slides group but is the one tool offered in a chat
 *  that is NOT bound to a deck. */
export const START_DECK_TOOL_NAME = 'start_deck';

/** The Slides group: tools that build a deck, offered only in a chat bound to one. */
export const DECK_TOOL_NAMES = new Set(
  builtinToolDefinitions()
    .filter((tool) => tool.displayGroup === DECK_TOOL_GROUP && tool.name !== START_DECK_TOOL_NAME)
    .map((tool) => tool.name),
);

/** The turn asks for slides, a deck or a presentation (English). */
export function looksLikeDeckRequest(prompt: string): boolean {
  return /\b(slides?|slide\s+deck|deck|decks|presentations?|pitch\s+deck|keynote|powerpoint)\b/i.test(prompt);
}

/** Document write and edit tools: left out of a deck-request turn so the model
 *  cannot take the document path instead of `start_deck`. */
function isDocumentWriteOrEditTool(name: string): boolean {
  return name.startsWith('write_') || name.startsWith('edit_');
}

export function isDeckTool(name: string): boolean {
  return DECK_TOOL_NAMES.has(name);
}

const STORYLINE_STAGE_DECK_TOOL_NAMES = new Set(['read_deck', 'set_storyline']);

/**
 * The deck tools for a deck's stage: while the storyline is being agreed the
 * model can only read the deck and write the storyline; once slides are being
 * built it gets all of them.
 */
export function selectBuiltinDeckTools(stage: DeckStage): ToolDefinition[] {
  return builtinToolDefinitions().filter(
    (tool) =>
      DECK_TOOL_NAMES.has(tool.name) &&
      (stage === 'slides' || STORYLINE_STAGE_DECK_TOOL_NAMES.has(tool.name)),
  );
}

/** The Writing group: tools that write a draft, offered only in a draft's chat. */
export const DRAFT_TOOL_NAMES = new Set(
  builtinToolDefinitions()
    .filter((tool) => tool.displayGroup === DRAFT_TOOL_GROUP)
    .map((tool) => tool.name),
);

export function isDraftTool(name: string): boolean {
  return DRAFT_TOOL_NAMES.has(name);
}

/** Draft tools that change the draft (refetch the draft after one finishes). */
export function isDraftWriteTool(name: string): boolean {
  return DRAFT_TOOL_NAMES.has(name) && name !== 'read_draft';
}

const OUTLINE_STAGE_DRAFT_TOOL_NAMES = new Set(['read_draft', 'set_outline']);
const DRAFT_STAGE_DRAFT_TOOL_NAMES = new Set(['read_draft', 'write_section', 'edit_blocks', 'replace_in_draft']);

/**
 * The draft tools for a draft's stage: while the outline is being agreed the
 * model can read the draft and propose the outline; once the outline is
 * approved it writes and edits the draft (and no longer rewrites the outline).
 */
export function selectBuiltinDraftTools(stage: DraftStage): ToolDefinition[] {
  const names = stage === 'outline' ? OUTLINE_STAGE_DRAFT_TOOL_NAMES : DRAFT_STAGE_DRAFT_TOOL_NAMES;
  return builtinToolDefinitions().filter((tool) => DRAFT_TOOL_NAMES.has(tool.name) && names.has(tool.name));
}

/** A draft's web search can run: web search on, its notice accepted, not local-only. */
export function draftWebSearchAvailable(settings: {
  webSearchEnabled?: boolean;
  webSearchConsentAcknowledged?: boolean;
  localOnly?: boolean;
}): boolean {
  return settings.webSearchEnabled === true && settings.webSearchConsentAcknowledged === true && !settings.localOnly;
}

/** Workspace tools that change files, as opposed to reading or searching them. */
const WORKSPACE_WRITE_TOOL_NAMES = new Set(['workspace_write', 'workspace_edit']);

/**
 * True when the prompt points at a file in the user's project: a file, folder
 * or path, or a filename with an extension ("notes.md").
 */
export function mentionsWorkspaceFileTarget(prompt: string): boolean {
  return (
    /\b(files?|folders?|director(y|ies)|paths?|repo(sitory)?|project|workspace|disk)\b/i.test(prompt) ||
    /\b[\w-]+\.(html?|md|markdown|txt|json|csv|ya?ml|toml|css|scss|jsx?|tsx?|py|rs|go|java|rb|sh)\b/i.test(prompt)
  );
}

/**
 * The built-in tools for one turn: document, brand, workspace and memory tools.
 * Web and connector tools are resolved separately by the caller.
 *
 * One function because three call sites in `ChatView.tsx` (the request itself
 * and two token estimates) used to assemble this list independently, and the
 * estimates must match what is actually sent.
 *
 * On a document turn, workspace *write* tools are left out unless the prompt
 * names a file, folder or path: two tools that can both "write an HTML file"
 * left the choice to the model, which picked `workspace_write` and produced a
 * file on disk instead of a document in the panel. Read and search tools stay,
 * so the model can still use project files as source material.
 */
export function selectBuiltinTurnTools(
  prompt: string,
  settings: {
    workspaceToolsEnabled?: boolean;
    workspaceRoot?: string | null;
    workspaceToolsConsentAcknowledged?: boolean;
    memoryEnabled: boolean;
    /** t0-8 M4: the active chat provider. Used only to gate `generate_image`
     *  on provider capability (`defaultImageModel`) -- never the active chat
     *  model, which is never an image model (see `selectBuiltinImageTools`). */
    activeProvider?: string;
    /** t0-8 M4: persisted first-use consent for image generation, mirroring
     *  `workspaceToolsConsentAcknowledged`'s shape. */
    imageGenerationConsentAcknowledged?: boolean;
    /** Web search availability, checked for a draft turn's `draftWebSearch`
     *  (the same rule as chat web search and Research). */
    webSearchEnabled?: boolean;
    webSearchConsentAcknowledged?: boolean;
    localOnly?: boolean;
  },
  conversationRoot?: string | null,
  /** Set by app-authored prompts (e.g. "Continue building") whose intent is
   *  known regardless of the language they are written in. */
  intentOverride?: DocumentTurnIntent,
  /** The turn asks for an image whatever its wording — an idea picked from
   *  the Ideas page, in any language (the intent regexes are English). */
  imageOverride?: boolean,
  /** Set when the chat is bound to a Slides deck: the deck tools replace the
   *  document, brand and image tools, which would write outside the deck. */
  deckStage?: DeckStage | null,
  /** Set when the chat is a Writing draft's chat: the draft tools for the
   *  stage replace the document, deck, brand and image tools. Never inferred
   *  from the prompt. */
  draftStage?: DraftStage | null,
  /** The draft's Sources turn web search on: a draft turn also gets the
   *  local `web_search` and `web_fetch` tools (never provider-hosted search,
   *  whose citations cannot be written into the draft). Only when web search
   *  is on, its notice accepted and the app is not local-only; ignored
   *  outside a draft chat. */
  draftWebSearch?: boolean,
): { intent: DocumentTurnIntent; tools: ToolDefinition[] } {
  if (draftStage) {
    const webTools =
      draftWebSearch === true && draftWebSearchAvailable(settings) ? selectBuiltinWebTools() : [];
    return {
      intent: 'edit',
      tools: [
        ...builtinToolDefinitions().filter((t) => UTILITY_TOOL_NAMES.has(t.name)),
        ...selectBuiltinDraftTools(draftStage),
        ...webTools,
        ...selectBuiltinWorkspaceTools(settings, conversationRoot).filter(
          (tool) => !WORKSPACE_WRITE_TOOL_NAMES.has(tool.name),
        ),
        ...selectBuiltinMemoryTools(settings.memoryEnabled),
      ],
    };
  }
  if (deckStage) {
    return {
      intent: 'edit',
      tools: [
        ...builtinToolDefinitions().filter(
          (t) => UTILITY_TOOL_NAMES.has(t.name) && !DECK_CHAT_OMITTED_UTILITY_TOOL_NAMES.has(t.name),
        ),
        ...selectBuiltinDeckTools(deckStage),
        ...selectBuiltinWorkspaceTools(settings, conversationRoot).filter(
          (tool) => !WORKSPACE_WRITE_TOOL_NAMES.has(tool.name),
        ),
        ...selectBuiltinMemoryTools(settings.memoryEnabled),
      ],
    };
  }
  const intent = intentOverride ?? classifyDocumentTurnIntent(prompt);
  const documentTurn = intent === 'create' || intent === 'edit';
  const workspaceTools = selectBuiltinWorkspaceTools(settings, conversationRoot).filter(
    (tool) =>
      !documentTurn || !WORKSPACE_WRITE_TOOL_NAMES.has(tool.name) || mentionsWorkspaceFileTarget(prompt),
  );
  const deckRequest = looksLikeDeckRequest(prompt);
  const startDeckTools = deckRequest
    ? builtinToolDefinitions().filter((tool) => tool.name === START_DECK_TOOL_NAME)
    : [];
  const documentTools = selectBuiltinDocumentTools(intent);
  return {
    intent,
    tools: [
      ...(deckRequest ? documentTools.filter((tool) => !isDocumentWriteOrEditTool(tool.name)) : documentTools),
      ...startDeckTools,
      ...selectBuiltinBrandTools(looksLikeBrandThemeRequest(prompt)),
      ...selectBuiltinImageTools(
        imageOverride === true || looksLikeImageGenerationRequest(prompt),
        settings.activeProvider,
        settings.imageGenerationConsentAcknowledged,
      ),
      ...workspaceTools,
      ...selectBuiltinMemoryTools(settings.memoryEnabled),
    ],
  };
}

/**
 * Model-facing note for a turn whose only output was document writes, e.g.
 * `[Wrote HTML document "Solar System Field Guide" with write_html_document.]`.
 *
 * Success is judged as "complete and not failed or cancelled" rather than
 * `status === 'completed'`: execution-finished events are not persisted, so a
 * reloaded turn has no status at all. Empty when there is nothing to report.
 */
export function documentWritesHistoryNote(state: AssistantStreamState | undefined): string {
  if (!state) return '';
  return state.toolCalls
    .filter(
      (tc) =>
        isDocumentContentTool(tc.name) &&
        tc.complete &&
        tc.status !== 'failed' &&
        tc.status !== 'cancelled',
    )
    .map((tc) => {
      if (isDocumentPatchTool(tc.name)) {
        const edits = Array.isArray(tc.arguments?.edits) ? tc.arguments.edits.length : 0;
        return `[Patched a document with patch_document (${edits} edit${edits === 1 ? '' : 's'}).]`;
      }
      const verb = tc.name.startsWith('edit_') ? 'Updated' : 'Wrote';
      const kind = KIND_BY_TOOL[tc.name] === 'html' ? 'HTML' : KIND_BY_TOOL[tc.name] === 'markdown' ? 'Markdown' : 'text';
      const title = typeof tc.arguments?.title === 'string' && tc.arguments.title.trim() ? ` "${tc.arguments.title.trim()}"` : '';
      return `[${verb} ${kind} document${title} with ${tc.name}.]`;
    })
    .join('\n');
}

/**
 * A line saying a past turn used the web, for the history the next request
 * carries. Tool calls never reach history, so a later turn without search
 * read an earlier, cited answer as unsourced and told the user it had made the
 * findings up. Hosted searches count too: they arrive as `web_search` records.
 */
export function webToolsHistoryNote(state: AssistantStreamState | undefined): string {
  if (!state) return '';
  const done = (name: string) =>
    state.toolCalls.filter(
      (tc) => tc.name === name && tc.complete && tc.status !== 'failed' && tc.status !== 'cancelled',
    ).length;
  const searches = done('web_search');
  const fetches = done('web_fetch');
  if (searches === 0 && fetches === 0) return '';
  const parts = [
    searches > 0 ? `searched the web ${searches} time${searches === 1 ? '' : 's'}` : '',
    fetches > 0 ? `read ${fetches} page${fetches === 1 ? '' : 's'} with web_fetch` : '',
  ].filter(Boolean);
  return `[This reply ${parts.join(' and ')}; its findings and links came from those real results.]`;
}

/** Document calls that changed a document. Reads and exports used to count,
 *  so a turn that only read the page (26 times, live) ended on "Document
 *  updated" and reopened a document nothing had touched. */
export function completedDocumentToolCalls(state: AssistantStreamState): ToolCallState[] {
  return state.toolCalls.filter(
    (toolCall) => toolCall.status === 'completed' && DOCUMENT_CONTENT_TOOL_NAMES.has(toolCall.name),
  );
}

export function hadSuccessfulDocumentToolCalls(state: AssistantStreamState): boolean {
  return completedDocumentToolCalls(state).length > 0;
}

export function failedDocumentToolCalls(state: AssistantStreamState): ToolCallState[] {
  return state.toolCalls.filter(
    (toolCall) => toolCall.status === 'failed' && DOCUMENT_TOOL_NAMES.has(toolCall.name),
  );
}

export function hadFailedDocumentToolCalls(state: AssistantStreamState): boolean {
  return failedDocumentToolCalls(state).length > 0;
}

/** Pick the artifact the document panel should open after an agent turn. */
export function resolveDocumentArtifactId(
  state: AssistantStreamState,
  listed: Artifact[],
): string | undefined {
  const completed = completedDocumentToolCalls(state);
  if (completed.length === 0) return undefined;

  let artifactId: string | undefined;
  for (const toolCall of completed) {
    if (toolCall.name.startsWith('write_')) {
      const id = toolCall.arguments?.artifact_id;
      artifactId = typeof id === 'string' && id.trim() !== '' ? id : undefined;
      continue;
    }
    const id = toolCall.arguments?.artifact_id;
    if (typeof id === 'string' && id.trim() !== '') {
      artifactId = id;
    }
  }

  if (!artifactId && completed.some((toolCall) => toolCall.name.startsWith('write_'))) {
    return listed[0]?.id;
  }

  return artifactId;
}

/* Ids, not display words. These reach the UI through `documentKindLabel` and
 * an ICU `select`; a word here would be English in every locale. */
const KIND_BY_TOOL: Record<string, string> = {
  write_html_document: 'html',
  edit_html_document: 'html',
  write_markdown_document: 'markdown',
  edit_markdown_document: 'markdown',
  write_text_document: 'text',
  edit_text_document: 'text',
};

const ACTION_BY_TOOL: Record<string, string> = {
  write_html_document: 'create',
  edit_html_document: 'edit',
  write_markdown_document: 'create',
  edit_markdown_document: 'edit',
  write_text_document: 'create',
  edit_text_document: 'edit',
  patch_document: 'edit',
  read_document: 'read',
};

export interface DocumentToolSummary {
  /** `create` | `edit` | `document`. An id — translate before showing it. */
  action: string;
  /** `html` | `markdown` | `text` | `document`. An id, likewise. */
  kind: string;
  title?: string;
  filename?: string;
  lineCount: number;
  charCount: number;
}

/** Summarize a document tool call for compact display (no full content). */
export function summarizeDocumentToolCall(toolCall: ToolCallState): DocumentToolSummary | undefined {
  if (!DOCUMENT_TOOL_NAMES.has(toolCall.name)) return undefined;
  // Arguments are only parsed at `toolCallComplete`. Until then the streaming
  // scan is the one place the title and size are known.
  const live = toolCall.arguments === undefined ? toolCall.documentWrite : undefined;
  if (live) {
    return {
      action: ACTION_BY_TOOL[toolCall.name] ?? 'document',
      kind: KIND_BY_TOOL[toolCall.name] ?? 'document',
      title: live.title?.trim() || undefined,
      filename: live.filename?.trim() || undefined,
      lineCount: live.contentLines,
      charCount: live.contentChars,
    };
  }
  const args = toolCall.arguments ?? {};
  const contentField = CONTENT_FIELD_BY_TOOL[toolCall.name];
  // A patch's size is the text it puts in, not the whole document.
  const content = isDocumentPatchTool(toolCall.name)
    ? (Array.isArray(args.edits) ? args.edits : [])
        .map((edit) =>
          edit && typeof edit === 'object' && typeof (edit as { new_text?: unknown }).new_text === 'string'
            ? (edit as { new_text: string }).new_text
            : '',
        )
        .join('\n')
    : typeof args[contentField] === 'string'
      ? (args[contentField] as string)
      : '';
  const lineCount = content ? content.split('\n').length : 0;
  const charCount = content.length;
  const title = typeof args.title === 'string' ? args.title : undefined;
  const filename = typeof args.filename === 'string' ? args.filename : undefined;
  return {
    action: ACTION_BY_TOOL[toolCall.name] ?? 'document',
    kind: KIND_BY_TOOL[toolCall.name] ?? 'document',
    title,
    filename,
    lineCount,
    charCount,
  };
}

/// Artifact `kind` as it appears in backend error strings → display word.
/// `ensure_kind` in `src-tauri/src/agent_tools.rs` — the only tool error whose
/// wording maps to something a reader can act on.
const KIND_MISMATCH = /^artifact '[^']+' is '([^']+)' not '([^']+)'$/;

/**
 * Translate a backend tool error into plain language.
 *
 * Tool errors are written for whoever is reading a log, and the raw string was
 * previously the visible conclusion of a failed turn. Recognised errors get a
 * sentence that says what happened and what to do; everything else falls back
 * to the original text. Callers keep the raw string available either way.
 */
export function explainToolError(error: string | undefined, fallback: string, t: Translate): string {
  if (!error) return fallback;
  const mismatch = KIND_MISMATCH.exec(error.trim());
  if (mismatch) {
    const actual = documentKindLabel(mismatch[1], t);
    const expected = documentKindLabel(mismatch[2], t);
    return t('chat.toolError.kindMismatch', { actual, expected });
  }
  return error;
}

/** Redact the large content field(s) from arguments for compact display. */
export function redactDocumentToolArguments(
  args: Record<string, unknown>,
  toolName: string,
): Record<string, unknown> {
  if (isDocumentPatchTool(toolName) && Array.isArray(args.edits)) {
    return { ...args, edits: `… ${args.edits.length}` };
  }
  const contentField = CONTENT_FIELD_BY_TOOL[toolName];
  if (!contentField) return args;
  const next: Record<string, unknown> = { ...args };
  if (contentField in next) {
    next[contentField] = '…';
  }
  return next;
}
