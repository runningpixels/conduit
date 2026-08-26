/// Brand-theme prompt helpers for teaching the model the `write_brand_theme`
/// contract (white-label plan §4, Phase 4). Modelled directly on
/// `artifactPrompt.ts`: a system-level appendix that states the format, plus
/// a lightweight intent detector that gates when it (and the tool itself)
/// are worth paying for.
///
/// ── Why this is gated, unlike the artifact appendix ─────────────────────
/// `CONDUIT_ARTIFACT_SYSTEM_APPENDIX` ships on nearly every turn — it is a
/// handful of short sentences, and document creation is a common enough
/// request that always-on is the right trade. This appendix is longer (it
/// has to explain a nested 18-key-times-two-themes shape, not a fenced code
/// block) and the underlying request — "design me a theme" — is rare by
/// comparison. Shipping it on every turn would tax every conversation for a
/// capability most of them never touch. So both the appendix and the tool
/// definition itself (`agentTools.ts`'s `selectBuiltinBrandTools`) are gated
/// on the same `looksLikeBrandThemeRequest` heuristic: only include the
/// vocabulary lesson on a turn where the tool is also plausibly relevant.

import { appName } from '../brand';

export function CONDUIT_BRAND_SYSTEM_APPENDIX(): string {
  return [
    `Call write_brand_theme only when the user explicitly asked to design, generate, or change ${appName()}'s look — a theme, a brand, a colour scheme, or a rebrand. It proposes a theme as a reviewable document; it does not change anything in the running app by itself, and the user previews or applies it explicitly afterward.`,
    'Provide appName and displayName, and both dark and light palettes in full — every one of the 18 keys, for both themes, even if only one theme was asked about. A theme missing one mode leaves that mode a mix of the new colours and the stock ones, which reads as broken rather than unfinished.',
    'Every palette value is a hex colour only: #rgb, #rrggbb, or #rrggbbaa. No named colours, no rgb()/hsl(), no CSS functions or variables.',
    'hue is the single accent colour, and its tints (washes, hovers, selection) derive from it automatically — do not invent extra keys for them. hueText, hueSolid, and onHue are separate, deliberately distinct values: hueText is the accent tuned for use as text, hueSolid is the accent as a solid fill, and onHue is the text colour drawn on top of that fill — do not set all three to the same value as hue.',
    'ink, ink2, and ink3 are primary, secondary, and tertiary text and must stay clearly readable against both bg and card in their own theme — do not pick a text colour close in lightness to the surfaces it sits on.',
    'Use notes for the design rationale in prose: what the theme is going for, why the accent and surfaces were chosen, what should survive a later revision. It is not shown as chrome in the app — it is fed back to you verbatim if the user asks to revise this theme, so write it for that future turn, not for this one.',
    'After the tool returns, do not say the theme has been applied — it has only been proposed.',
  ].join(' ');
}

/** Wh-questions and "tell me about / explain" are informational regardless of
 * which keywords appear later — same precedent as
 * `artifactPrompt.ts`'s `INFORMATIONAL_QUESTION_PREFIX_REGEX`. Kept as a
 * separate constant (not imported) since the two intents are independent and
 * a shared regex would couple their wording unnecessarily. */
const INFORMATIONAL_QUESTION_PREFIX_REGEX =
  /^(what|which|how|why|when|where|who|tell me about|explain)\b/i;

/** Unambiguous branding vocabulary — matching either of these is enough on
 * its own, no action verb required, since a bare "rebrand this" or "generate
 * a brand.md" is already an unambiguous request. */
const BRAND_NOUN_REGEX = /\bre[- ]?brand(?:ing)?\b|\bwhite[- ]?label(?:l?ing)?\b|\bbrand\.md\b/i;

/** An action verb paired with a branding-flavoured noun — covers phrasings
 * like "design a theme", "give it a new colour scheme", "change the accent
 * colour" without matching unrelated uses of "theme" or "colour" on their
 * own (e.g. "what's the theme of this book?", already filtered by the
 * informational-prefix check below). */
const THEME_ACTION_REGEX =
  /\b(create|make|generate|design|build|give|set|pick|choose|update|change|customi[sz]e|apply|new)\b[\s\S]*\b(theme|brand|colou?r[\s-]*scheme|palette|accent[\s-]*colou?r|look\s+and\s+feel)\b/i;

/**
 * True when the user prompt reads like a request to design or change a
 * white-label theme/brand — gates both the tool's visibility
 * (`agentTools.ts`'s `selectBuiltinBrandTools`) and this file's system
 * appendix. Deliberately conservative: a false negative just means the model
 * answers in prose or asks a clarifying question on the next turn; a false
 * positive pays for a large tool schema and appendix on an unrelated turn.
 */
export function looksLikeBrandThemeRequest(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) return false;
  // Checked first and unconditionally, same precedence as
  // `artifactPrompt.ts`'s `looksLikeArtifactCreationRequest`: "tell me about
  // white-labeling" is informational even though it contains unambiguous
  // branding vocabulary, so this must not be skippable by a noun match below.
  // Phrased-as-a-question requests ("can you rebrand this?") don't start
  // with any of these prefixes, so they still fall through correctly.
  if (INFORMATIONAL_QUESTION_PREFIX_REGEX.test(trimmed)) return false;
  if (BRAND_NOUN_REGEX.test(trimmed)) return true;
  return THEME_ACTION_REGEX.test(trimmed);
}
