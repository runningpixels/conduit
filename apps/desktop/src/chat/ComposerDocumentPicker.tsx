import { useT } from '../i18n';

/** One document the `#` picker can offer (t1-8 M3). Documents come from every
 *  collection, attached or not (D6), so this carries the collection name
 *  regardless of attachment. */
export interface DocumentPickerOption {
  documentId: string;
  title: string;
  collectionId: string;
  collectionName: string;
}

/** The DOM id an option renders at, for the textarea's `aria-activedescendant`. */
export function documentOptionId(documentId: string): string {
  return `composer-doc-option-${documentId}`;
}

interface ComposerDocumentPickerProps {
  /** Id of the `role="listbox"` itself, for the textarea's `aria-controls`. */
  id: string;
  options: DocumentPickerOption[];
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (option: DocumentPickerOption) => void;
}

/**
 * The `#` document-reference popover (t1-8 M3, D7/D11). Anchored above the
 * composer like its sibling popovers, but unlike them it never takes focus:
 * the textarea keeps it the whole time this is open, driven by
 * `aria-activedescendant`, and a pick uses `onMouseDown` (not `onClick`) so a
 * mouse pick never blurs the textarea first.
 */
export function ComposerDocumentPicker({
  id,
  options,
  activeIndex,
  onHover,
  onPick,
}: ComposerDocumentPickerProps) {
  const t = useT();
  return (
    <div className="composer-doc-picker">
      <ul id={id} role="listbox" aria-label={t('chat.composer.knowledgeRef.pickerAriaLabel')}>
        {options.length === 0 ? (
          <li className="composer-doc-picker-empty" role="presentation">
            {t('chat.composer.knowledgeRef.noMatches')}
          </li>
        ) : (
          options.map((option, index) => (
            <li
              key={option.documentId}
              id={documentOptionId(option.documentId)}
              role="option"
              aria-selected={index === activeIndex}
              // Explicit rather than left to the child text nodes: the two
              // elements below are trimmed independently by the accessible
              // name algorithm, which silently ate the separating space.
              aria-label={`${option.title} · ${option.collectionName}`}
              data-active={index === activeIndex}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                // Not onClick: a click would blur the textarea before this
                // handler ran, and focus must stay in the textarea (D11).
                event.preventDefault();
                onPick(option);
              }}
            >
              <b>{option.title}</b>
              <small>{option.collectionName}</small>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
