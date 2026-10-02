/// One live view of a deck: a sandboxed frame running the static deck
/// document (`deckDocument.ts`). The document is constant, so the frame
/// loads once; the deck and the slide to show are posted in by message and the
/// frame updates in place. Same isolation as `HtmlArtifactRenderer`:
/// `sandbox="allow-scripts"` only, no referrer, served by the artifact scheme.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import { assembleArtifactDoc, type ArtifactColorScheme } from '../artifacts/HtmlArtifactRenderer';
import { useArtifactFrameSource } from '../artifacts/artifactFrameSource';
import type { DeckDetail } from '../ipc/contracts';
import { DECK_FRAME_HTML, cleanInlineHtml, deckMessage, parseDeckEvent } from './deckDocument';

export interface DeckFrameProps {
  deck: DeckDetail;
  index: number;
  mode: 'stage' | 'thumb';
  colorScheme: ArtifactColorScheme;
  onSelect?: (slideId: string) => void;
  /** Stage only: slots can be selected and edited in place. */
  editable?: boolean;
  /** Stage only: full-screen presenting (black letterbox, no slide outline). */
  present?: boolean;
  onSlotSelect?: (slideId: string, index: number, name: string) => void;
  /** `html` has already been through `cleanInlineHtml`. */
  onSlotEdit?: (slideId: string, index: number, name: string, html: string) => void;
  onKey?: (key: string) => void;
  onOverflow?: (slides: Array<{ id: string; px: number }>) => void;
}

export function DeckFrame({
  deck,
  index,
  mode,
  colorScheme,
  onSelect,
  editable = false,
  present = false,
  onSlotSelect,
  onSlotEdit,
  onKey,
  onOverflow,
}: DeckFrameProps) {
  const t = useT();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [readyCount, setReadyCount] = useState(0);
  const handlers = useRef({ onSelect, onSlotSelect, onSlotEdit, onKey, onOverflow });
  handlers.current = { onSelect, onSlotSelect, onSlotEdit, onKey, onOverflow };

  const doc = useMemo(() => assembleArtifactDoc(DECK_FRAME_HTML, [], false, colorScheme), [colorScheme]);
  const source = useArtifactFrameSource(doc);

  // A thumbnail only ever shows one slide, so it is sent only that slide.
  const { themeCss, slides } = deck;
  // Keyed on the slide's own fields, so a refetch that changed other slides
  // does not re-post this thumbnail.
  const stageSlides = mode === 'stage' ? slides : null;
  const thumbSlide = mode === 'thumb' ? slides[index] : undefined;
  const thumbId = thumbSlide?.id;
  const thumbLayout = thumbSlide?.layout;
  const thumbHtml = thumbSlide?.html;
  const message = useMemo(() => {
    if (mode === 'thumb') {
      const one =
        thumbId != null
          ? [{ id: thumbId, position: 0, layout: thumbLayout ?? '', html: thumbHtml ?? '', notes: '', slots: [] }]
          : [];
      return deckMessage({ themeCss, slides: one }, { mode, index: 0 });
    }
    return deckMessage({ themeCss, slides: stageSlides ?? [] }, { mode, index, editable, present });
  }, [mode, themeCss, stageSlides, index, editable, present, thumbId, thumbLayout, thumbHtml]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const win = frameRef.current?.contentWindow;
      if (!win || event.source !== win) return;
      const parsed = parseDeckEvent(event.data);
      if (!parsed) return;
      const h = handlers.current;
      switch (parsed.event) {
        case 'ready':
          setReadyCount((n) => n + 1);
          break;
        case 'select':
          h.onSelect?.(parsed.slideId);
          break;
        case 'slot-select':
          h.onSlotSelect?.(parsed.slideId, parsed.index, parsed.name);
          break;
        case 'slot-edit':
          h.onSlotEdit?.(parsed.slideId, parsed.index, parsed.name, cleanInlineHtml(parsed.html));
          break;
        case 'key':
          h.onKey?.(parsed.key);
          break;
        case 'overflow':
          h.onOverflow?.(parsed.slides);
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (readyCount === 0) return;
    frameRef.current?.contentWindow?.postMessage(message, '*');
  }, [readyCount, message]);

  const frame =
    source.src || source.srcDoc != null ? (
      <iframe
        ref={frameRef}
        className="deck-frame-iframe"
        title={t('slides.frame.title')}
        // `allow-scripts` only, exactly as HtmlArtifactRenderer: never add
        // allow-same-origin or anything that gives the deck a way out.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={source.src}
        srcDoc={source.srcDoc}
        tabIndex={-1}
      />
    ) : null;

  if (mode === 'thumb') {
    const slide = slides[index];
    return (
      <button
        type="button"
        className="deck-frame deck-frame-thumb"
        aria-label={t('slides.strip.slideAria', { n: index + 1 })}
        onClick={() => slide && onSelect?.(slide.id)}
      >
        {frame}
      </button>
    );
  }
  return <div className="deck-frame deck-frame-stage">{frame}</div>;
}
