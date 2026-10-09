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
  /// Opens somewhere other than a chat: a deck idea starts in Slides, with
  /// its prompt in the story box.
  opens?: 'slides';
  /// Catalog revision that added it; newer than the last one seen → "New".
  addedIn: number;
  /// The free APIs (freeApis.ts ids) its page calls; the prompt names each.
  apis?: readonly string[];
  /// Last live battery pass with this prompt. Absent until the battery has
  /// run it — a new or reworded idea has not passed yet.
  verified?: { model: string; on: string };
}

/// Bump when ideas are added; ideas with `addedIn` above what a user last
/// saw are shown as new.
export const IDEAS_REVISION = 2;

const GLM = 'z-ai/glm-5.3-flash';

export const IDEAS: readonly Idea[] = [
  // Make a tool
  { id: 'pomodoroTimer', category: 'make', needs: [], size: 'quick', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'budgetTracker', category: 'make', needs: [], size: 'medium', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'unitConverter', category: 'make', needs: [], size: 'quick', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  // Make a tool, on a free API (revision 2; not yet through the battery)
  { id: 'bookFinder', category: 'make', needs: ['network'], size: 'medium', page: true, addedIn: 2, apis: ['openLibrary'] },
  { id: 'recipeFinder', category: 'make', needs: ['network'], size: 'medium', page: true, addedIn: 2, apis: ['mealDb'] },
  { id: 'holidayCalendar', category: 'make', needs: ['network'], size: 'medium', page: true, addedIn: 2, apis: ['nagerDate'] },
  { id: 'foodLabel', category: 'make', needs: ['network'], size: 'medium', page: true, addedIn: 2, apis: ['openFoodFacts'] },
  { id: 'tvShowFinder', category: 'make', needs: ['network'], size: 'medium', page: true, addedIn: 2, apis: ['tvMaze'] },
  { id: 'imageSearch', category: 'make', needs: ['network'], size: 'medium', page: true, addedIn: 2, apis: ['openverse'] },
  { id: 'npmPackageCard', category: 'make', needs: ['network'], size: 'quick', page: true, addedIn: 2, apis: ['npmRegistry'] },
  // Live data (ADR-010). The four from revision 1 were reworded to name
  // their API, so their battery pass no longer applies.
  { id: 'weatherDashboard', category: 'live', needs: ['network'], size: 'medium', page: true, addedIn: 1, apis: ['openMeteo', 'openMeteoGeo'] },
  { id: 'currencyConverter', category: 'live', needs: ['network'], size: 'medium', page: true, addedIn: 1, apis: ['frankfurter'] },
  { id: 'githubViewer', category: 'live', needs: ['network'], size: 'medium', page: true, addedIn: 1, apis: ['github'] },
  { id: 'morningBriefing', category: 'live', needs: ['network'], size: 'long', page: true, addedIn: 1, apis: ['openMeteo', 'hackerNews', 'wikipedia'] },
  { id: 'airQuality', category: 'live', needs: ['network'], size: 'medium', page: true, addedIn: 2, apis: ['openMeteoAir', 'openMeteoGeo'] },
  { id: 'goldenHour', category: 'live', needs: ['network'], size: 'medium', page: true, addedIn: 2, apis: ['sunriseSunset', 'openMeteoGeo'] },
  { id: 'earthquakeTracker', category: 'live', needs: ['network'], size: 'medium', page: true, addedIn: 2, apis: ['usgsQuakes'] },
  { id: 'cryptoTicker', category: 'live', needs: ['network'], size: 'quick', page: true, addedIn: 2, apis: ['coingecko'] },
  { id: 'issTracker', category: 'live', needs: ['network'], size: 'medium', page: true, addedIn: 2, apis: ['issPosition'] },
  { id: 'spaceLaunches', category: 'live', needs: ['network'], size: 'medium', page: true, addedIn: 2, apis: ['launchLibrary', 'spaceflightNews'] },
  { id: 'hackerNewsReader', category: 'live', needs: ['network'], size: 'medium', page: true, addedIn: 2, apis: ['hackerNews'] },
  // Learn something
  { id: 'periodicTable', category: 'learn', needs: [], size: 'long', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'flashcards', category: 'learn', needs: [], size: 'medium', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'compoundInterest', category: 'learn', needs: [], size: 'medium', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'cheatSheet', category: 'learn', needs: [], size: 'medium', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'onThisDay', category: 'learn', needs: ['network'], size: 'medium', page: true, addedIn: 2, apis: ['wikiOnThisDay'] },
  { id: 'wildlifeSightings', category: 'learn', needs: ['network'], size: 'medium', page: true, addedIn: 2, apis: ['inaturalist'] },
  { id: 'wordExplorer', category: 'learn', needs: ['network'], size: 'medium', page: true, addedIn: 2, apis: ['dictionary', 'datamuse'] },
  { id: 'artGallery', category: 'learn', needs: ['network'], size: 'medium', page: true, addedIn: 2, apis: ['artic'] },
  { id: 'poemOfTheDay', category: 'learn', needs: ['network'], size: 'quick', page: true, addedIn: 2, apis: ['poetryDb'] },
  // Play
  { id: 'snakeGame', category: 'play', needs: [], size: 'medium', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'capitalsQuiz', category: 'play', needs: [], size: 'medium', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'memoryGame', category: 'play', needs: [], size: 'medium', page: true, addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
  { id: 'triviaQuiz', category: 'play', needs: ['network'], size: 'medium', page: true, addedIn: 2, apis: ['openTrivia'] },
  { id: 'blackjack', category: 'play', needs: ['network'], size: 'medium', page: true, addedIn: 2, apis: ['deckOfCards'] },
  { id: 'pokedex', category: 'play', needs: ['network'], size: 'medium', page: true, addedIn: 2, apis: ['pokeApi'] },
  // Write & plan
  { id: 'pitchDeck', category: 'write', needs: [], size: 'long', page: false, opens: 'slides', addedIn: 1, verified: { model: GLM, on: '2026-09-26' } },
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
