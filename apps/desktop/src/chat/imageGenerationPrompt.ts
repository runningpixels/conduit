/// Image-generation prompt intent detector (t0-8 M4). Sibling of
/// `looksLikeBrandThemeRequest` (`chat/brandPrompt.ts`) and
/// `classifyDocumentTurnIntent` (`chat/documentTurnIntent.ts`): a lightweight,
/// conservative heuristic gating `generate_image`'s visibility for a turn
/// (`agentTools.ts`'s `selectBuiltinTurnTools`), not a general-purpose
/// classifier of "this prompt is about an image".
///
/// Deliberately biased toward false negatives over false positives.
/// `generate_image` is billed and side-effectful (t0-8 plan, "Risks": "a call
/// costs real money"), so a false positive costs the user money the moment
/// the model decides to call the tool; a false negative just means the model
/// answers in prose, or the user has to ask more directly on the next turn --
/// the same trade `looksLikeBrandThemeRequest` makes for its own (unbilled,
/// but still schema-heavy) tool.
///
/// Three things must NOT fire, beyond a plain unrelated prompt:
///  1. Capability/support questions about image generation itself
///     ("can you generate images?", "are you able to draw?").
///  2. Questions about image/file formats in general
///     ("what image formats do you support?").
///  3. Requests to *read*, describe, or analyze an existing image -- the
///     opposite (inbound) direction from generation, already covered by
///     `modelAcceptsImages.ts` / vision handling, never this tool.

/// Wh-questions and "tell me about / explain" are informational regardless of
/// which keywords appear later -- same precedent as `brandPrompt.ts`'s
/// `INFORMATIONAL_QUESTION_PREFIX_REGEX`. Deliberately excludes "can you" /
/// "do you" / "are you": those prefix a real, phrased-as-a-question request
/// ("can you generate an image of a cat?") just as often as a capability
/// question, so they are disambiguated later by `CAPABILITY_QUESTION_REGEX`
/// instead of being rejected outright here.
const INFORMATIONAL_QUESTION_PREFIX_REGEX =
  /^(what|which|how|why|when|where|who|tell me about|explain)\b/i;

/// Verbs that read, describe, or analyze an existing image -- the inbound
/// direction, never a reason to offer the (billed) generation tool. Paired
/// below with an image noun so this cannot fire on an unrelated "describe the
/// plan" or "identify the risks".
const IMAGE_READING_VERB_REGEX =
  /\b(read|look\s+at|analy[sz]\w*|describ\w*|caption\w*|identif\w*|summari\w*|what'?s?\s+(is\s+)?in)\b/i;

/// Creation verb stems, shared between the positive match and the capability
/// question negative below so both recognise the same vocabulary
/// ("generate", "generates", "generating", ... via the trailing `\w*`).
const CREATION_VERB_STEMS =
  'generat\\w*|creat\\w*|mak\\w*|draw\\w*|design\\w*|produc\\w*|render\\w*|paint\\w*|sketch\\w*|illustrat\\w*';

/// Nouns for the *product* of image generation -- a picture, a logo, etc. --
/// as distinct from the subject matter of an unrelated message. Deliberately
/// narrow: no bare "art" (too broad -- "explain this piece of art" is
/// informational already, but there is no positive case that needs it).
const IMAGE_PRODUCT_NOUNS =
  'images?|pictures?|photos?|logos?|illustrations?|graphics?|icons?|artworks?|drawings?|sketches|wallpapers?|avatars?|portraits?|paintings?|posters?|thumbnails?';

const IMAGE_READING_REGEX = new RegExp(
  `${IMAGE_READING_VERB_REGEX.source}[\\s\\S]*\\b(image|picture|photo|screenshot|attachment|file|logo)s?\\b`,
  'i',
);

/// Bare capability/support questions about image generation as a feature, not
/// a request for a specific image -- "can you generate images?", "do you
/// support making pictures?", "are you able to draw logos for me?". Matched
/// only when the image noun is immediately followed by (at most) a short,
/// generic tail ("?", "for me", "at all") and nothing else -- a concrete
/// object ("...an image of a mountain sunset") runs on past that tail and so
/// is never caught here, which is what separates this from an actual request
/// phrased as a question.
const CAPABILITY_QUESTION_REGEX = new RegExp(
  `\\b(can|could|do|does|are)\\b[\\s\\S]{0,40}\\b(${CREATION_VERB_STEMS})\\b\\s+` +
    `(${IMAGE_PRODUCT_NOUNS})\\b(\\s+(for me|at all))?[\\s?]*$`,
  'i',
);

/// Questions about image/file *formats* or support in general, not a
/// generation request -- "what image formats do you support?" (also caught by
/// the informational prefix above when it leads with "what"/"which", kept
/// here too for phrasings that don't: "do you support other image formats?").
const FORMAT_QUESTION_REGEX =
  /\b(image|file)\s+formats?\b|\bformats?\s+(do|does|can)\s+you\s+(support|output|generate|produce)\b/i;

/// A creation verb paired with an image-product noun -- "generate an image
/// of...", "draw me a logo for...", "make an illustration of...".
const IMAGE_CREATION_REGEX = new RegExp(
  `\\b(${CREATION_VERB_STEMS})\\b[\\s\\S]*\\b(${IMAGE_PRODUCT_NOUNS})\\b`,
  'i',
);

/**
 * True when the user prompt reads like a clear request to generate an image
 * -- gates `generate_image`'s visibility (`agentTools.ts`'s
 * `selectBuiltinTurnTools`, via `selectBuiltinImageTools`). See the module
 * doc comment for the three cases this must NOT fire on.
 */
export function looksLikeImageGenerationRequest(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) return false;

  // Checked first and unconditionally, same precedence as
  // `looksLikeBrandThemeRequest`/`looksLikeArtifactCreationRequest`: "what is
  // an image?" is informational even though a later regex might otherwise
  // match a keyword in it.
  if (INFORMATIONAL_QUESTION_PREFIX_REGEX.test(trimmed)) return false;

  // Reading/describing/analyzing an existing image is the opposite direction
  // from generating a new one -- never gate the billed generation tool on it.
  if (IMAGE_READING_REGEX.test(trimmed)) return false;

  // Capability/format questions ask *about* the feature, not for a specific
  // image -- checked before the creation regex so "can you generate images?"
  // doesn't fall through to a bare keyword match on "generate ... images".
  if (CAPABILITY_QUESTION_REGEX.test(trimmed)) return false;
  if (FORMAT_QUESTION_REGEX.test(trimmed)) return false;

  return IMAGE_CREATION_REGEX.test(trimmed);
}
