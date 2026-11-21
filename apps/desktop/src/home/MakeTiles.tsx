/// Home's "Make something new": one tile per kind of thing to make. Picking a
/// tile readies the ask box for it (its chip, its placeholder) instead of
/// leaving Home; picking it again, or the chip's ×, clears it.

import { useId, type ReactNode } from 'react';
import { useT } from '../i18n';
import { FileIcon, ImageIcon, SheetIcon, SlidesIcon, WindowIcon, WritingIcon } from '../icons';
import { MAKE_KINDS, type MakeKind } from './makeKinds';

export const MAKE_ICONS: Record<MakeKind, ReactNode> = {
  page: <FileIcon />,
  app: <WindowIcon />,
  deck: <SlidesIcon />,
  document: <WritingIcon />,
  sheet: <SheetIcon />,
  image: <ImageIcon />,
};

export interface MakeTilesProps {
  picked: MakeKind | null;
  onPick: (kind: MakeKind | null) => void;
}

export function MakeTiles({ picked, onPick }: MakeTilesProps) {
  const t = useT();
  const labelId = useId();
  return (
    <section className="home-section home-make" aria-labelledby={labelId}>
      <h3 id={labelId} className="home-make-heading">
        {t('home.make.heading')}
      </h3>
      <ul className="home-make-grid">
        {MAKE_KINDS.map((kind) => (
          <li key={kind}>
            <button
              type="button"
              className="home-make-tile"
              data-kind={kind}
              aria-pressed={picked === kind}
              onClick={() => onPick(picked === kind ? null : kind)}
            >
              <span className="home-make-icon" aria-hidden="true">
                {MAKE_ICONS[kind]}
              </span>
              <span className="home-make-name">{t(`home.make.${kind}.name`)}</span>
              <span className="home-make-hint">{t(`home.make.${kind}.hint`)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
