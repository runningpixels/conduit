import { AgentsIcon } from '../icons';
import { useT } from '../i18n';

/** One library agent the `@` picker can offer. */
export interface AgentPickerOption {
  id: string;
  name: string;
  /** First line of its instructions. */
  about: string;
}

/** The DOM id an option renders at, for the textarea's `aria-activedescendant`. */
export function agentOptionId(agentId: string): string {
  return `composer-agent-option-${agentId}`;
}

interface ComposerAgentPickerProps {
  /** Id of the `role="listbox"` itself, for the textarea's `aria-controls`. */
  id: string;
  options: AgentPickerOption[];
  /** The library has no agents at all (as opposed to none matching). */
  libraryEmpty: boolean;
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (option: AgentPickerOption) => void;
}

/** The `@` agent popover. Like the `#` picker it never takes focus: the textarea
 *  drives it with `aria-activedescendant`, and a pick uses `onMouseDown` so a
 *  mouse pick does not blur the textarea first. */
export function ComposerAgentPicker({
  id,
  options,
  libraryEmpty,
  activeIndex,
  onHover,
  onPick,
}: ComposerAgentPickerProps) {
  const t = useT();
  return (
    <div className="composer-doc-picker">
      <ul id={id} role="listbox" aria-label={t('chat.composer.agents.pickerAriaLabel')}>
        {options.length === 0 ? (
          <li className="composer-doc-picker-empty" role="presentation">
            {libraryEmpty ? t('chat.composer.agents.none') : t('chat.composer.agents.noMatches')}
          </li>
        ) : (
          options.map((option, index) => (
            <li
              key={option.id}
              id={agentOptionId(option.id)}
              role="option"
              aria-selected={index === activeIndex}
              aria-label={option.about ? `${option.name} · ${option.about}` : option.name}
              data-active={index === activeIndex}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(option);
              }}
            >
              <AgentsIcon />
              <b>{option.name}</b>
              {option.about ? <small>{option.about}</small> : null}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
