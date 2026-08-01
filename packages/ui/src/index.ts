/*
 * @conduit/ui — design-token + primitives home (ADR-005).
 *
 * Tokens and primitive CSS live in `./tokens.css`; import it once at the app
 * root (`import '@conduit/ui/tokens.css'`). The old `themeTokens` mirror object
 * is intentionally removed — it duplicated the CSS custom properties and was
 * being misused as a diagnostics JSON dump in the renderer.
 */
export const tokensCssPath = './tokens.css';

export type {
  ButtonProps,
  ButtonVariant,
  IconButtonProps,
  StatusTone,
  PillProps,
  ChipProps,
  SearchBoxProps,
  InfoCardProps,
  SectionLabelProps,
  AvatarProps,
  AvatarRole,
  ConfirmDialogProps,
} from './primitives';

export {
  Button,
  IconButton,
  StatusPill,
  Chip,
  SearchBox,
  InfoCard,
  SectionLabel,
  Avatar,
  ConfirmDialog,
} from './primitives';
