import { useMemo, useState } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import {
  draftFromControls,
  GenerationFields,
  parseGenerationDraft,
} from '../../chat/GenerationFields';

interface GenerationControlsSectionProps {
  settings: AppSettings;
  onUpdate: (s: AppSettings) => void;
  onStatus: (message: string) => void;
}

/** App-default generation parameters and user instructions (Settings → Chat defaults). */
export function GenerationControlsSection({
  settings,
  onUpdate,
  onStatus,
}: GenerationControlsSectionProps) {
  const [draft, setDraft] = useState(() =>
    draftFromControls(settings.generationControls, settings.userInstructions),
  );
  const serialized = useMemo(
    () => JSON.stringify(draftFromControls(settings.generationControls, settings.userInstructions)),
    [settings.generationControls, settings.userInstructions],
  );

  // Re-sync when settings change from elsewhere (auto-save echo).
  const [prevSerialized, setPrevSerialized] = useState(serialized);
  if (serialized !== prevSerialized) {
    setPrevSerialized(serialized);
    setDraft(draftFromControls(settings.generationControls, settings.userInstructions));
  }

  function handleChange(next: ReturnType<typeof draftFromControls>) {
    setDraft(next);
  }

  function handleCommit(next: ReturnType<typeof draftFromControls>) {
    const parsed = parseGenerationDraft(next);
    if (parsed.error) {
      onStatus(parsed.error);
      return;
    }
    onUpdate({
      ...settings,
      generationControls: parsed.controls,
      userInstructions: parsed.userInstructions,
    });
  }

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>Model parameters</span>
      </div>
      <p style={{ marginBottom: 12, fontSize: '12px', color: 'var(--ink-2)' }}>
        Applied to new chats. A single chat can override these from the composer Chat settings
        chip. Empty fields leave the provider default.
      </p>
      <GenerationFields
        draft={draft}
        onChange={handleChange}
        onCommit={handleCommit}
        idPrefix="settings-gen"
      />
    </div>
  );
}
