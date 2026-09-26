/// The ideas catalog: small, tested starting points that show what Conduit can
/// do (docs/plans/ideas-and-discovery.md).
///
/// Each idea's text lives in the i18n catalogs under `ideas.item.<id>.*`
/// (`title`, `blurb`, `prompt`), so a German user sends a German prompt. The
/// catalog ships with the app: it changes when the app updates, which is also
/// when new capabilities arrive.
///
/// Every idea must still work. Before a release the ideas battery runs each
/// prompt live and `verified` records the last pass; `catalog.test.ts` checks
/// the rest (strings, needs, and that a page idea reaches the document tools).

/// Something an idea needs beyond a chat model. Anything else — pages, games,
/// explanations — works with any model, local ones included.
export type Capability = 'network' | 'webSearch' | 'imageGen' | 'documents' | 'workspace';

export const CAPABILITIES: readonly Capability[] = ['network', 'webSearch', 'imageGen', 'documents', 'workspace'];

/// By what the user wants, not by feature (after Claude's artifact gallery).
export type IdeaCategory = 'make' | 'live' | 'learn' | 'play' | 'write' | 'files' | 'images';

export const IDEA_CATEGORIES: readonly IdeaCategory[] = ['make', 'live', 'learn', 'play', 'write', 'files', 'images'];

export interface Idea {
  /// Stable: used for i18n keys and for "tried" on this device.
  id: string;
  category: IdeaCategory;
  needs: readonly Capability[];
  /// Expected size of the answer, for the cost hint.
  size: 'quick' | 'medium' | 'long';
  /// The answer is a page (HTML document) — the prompt must route to the
  /// document tools, or the model writes one sentence and stops.
  page: boolean;
  /// Catalog revision that added it; newer than the last one seen → "New".
  addedIn: number;
  /// Last live battery pass.
  verified: { model: string; on: string };
}

/// Bump when ideas are added; ideas with `addedIn` above what a user last
/// saw are shown as new.
export const IDEAS_REVISION = 1;

const GLM = 'z-ai/glm-5.3-flash';

export const IDEAS: readonly Idea[] = [
  // Make a tool
  { id: 'pomodoroTimer', category: 'make', needs: [], size: 'quick', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'budgetTracker', category: 'make', needs: [], size: 'medium', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'unitConverter', category: 'make', needs: [], size: 'quick', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  // Live data (ADR-010)
  { id: 'weatherDashboard', category: 'live', needs: ['network'], size: 'medium', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'currencyConverter', category: 'live', needs: ['network'], size: 'medium', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'githubViewer', category: 'live', needs: ['network'], size: 'medium', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'morningBriefing', category: 'live', needs: ['network'], size: 'long', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  // Learn something
  { id: 'periodicTable', category: 'learn', needs: [], size: 'long', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'flashcards', category: 'learn', needs: [], size: 'medium', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'compoundInterest', category: 'learn', needs: [], size: 'medium', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'cheatSheet', category: 'learn', needs: [], size: 'medium', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  // Play
  { id: 'snakeGame', category: 'play', needs: [], size: 'medium', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'capitalsQuiz', category: 'play', needs: [], size: 'medium', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'memoryGame', category: 'play', needs: [], size: 'medium', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  // Write & plan
  { id: 'pitchDeck', category: 'write', needs: [], size: 'long', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'landingPage', category: 'write', needs: [], size: 'medium', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'weekInReview', category: 'write', needs: ['webSearch'], size: 'medium', page: false, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  // Your files
  { id: 'askDocuments', category: 'files', needs: ['documents'], size: 'medium', page: false, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'improveReadme', category: 'files', needs: ['workspace'], size: 'medium', page: false, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  // Images
  { id: 'bakeryLogo', category: 'images', needs: ['imageGen'], size: 'quick', page: false, addedIn: 1, verified: { model: 'gpt-image-2.5', on: '2026-09-26' } },
  { id: 'storyIllustration', category: 'images', needs: ['imageGen'], size: 'quick', page: false, addedIn: 1, verified: { model: 'gpt-image-2.5', on: '2026-09-26' } },
];

export function ideaById(id: string): Idea | undefined {
  return IDEAS.find((idea) => idea.id === id);
}
