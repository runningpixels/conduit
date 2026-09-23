import { useT } from '../../i18n';

interface PdfImportNoticeDialogProps {
  /** True when the dialog should be visible. The parent controls this. */
  visible: boolean;
  /** Called when the user continues. Persists the acknowledgement, then the
   *  import proceeds (through the embedding consent gate if that is still
   *  pending). */
  onContinue: () => void;
  /** Called when the user backs out. The document is left unindexed. */
  onCancel: () => void;
}

/**
 * The one-time PDF import notice (t1-6 M6).
 *
 * Shown the **first** time a PDF is imported into any collection, then never
 * again -- not per file, not per collection, and not after a restart. Backed
 * by `AppSettings.pdf_import_notice_acknowledged`.
 *
 * It carries two things, because a user who hits a bad extraction will
 * otherwise assume the app is broken:
 *
 * 1. Where the parsing happens -- on this machine, by a third-party
 *    open-source library. The file is not uploaded to be parsed. (What *is*
 *    sent to a provider is the extracted text, and that is the separate
 *    embedding consent.)
 * 2. That extraction is imperfect, and how: columns and tables can come out
 *    in the wrong order, and a scanned PDF with no text layer yields nothing
 *    at all. That second case is the one people actually collide with.
 *
 * **Deliberate wording note.** This notice does *not* describe PDF import as
 * unsafe. That would be inaccurate in the direction that matters: the crates
 * that parse PDF structure contain zero `unsafe` and there is no native code
 * in the tree, which is a stronger position than the C++ parsers shipped in
 * Acrobat, Preview and Chrome. Calling the memory-safe choice dangerous would
 * mislabel it and spend trust needed for the prompts that carry real
 * consequences -- sending documents to a provider, and spending money.
 *
 * The library's name belongs in the plan and in Settings, not in this dialog:
 * it is detail almost nobody can act on, and it would crowd out the sentence
 * about scanned PDFs that they can.
 */
export function PdfImportNoticeDialog({
  visible,
  onContinue,
  onCancel,
}: PdfImportNoticeDialogProps) {
  const t = useT();

  if (!visible) return null;

  return (
    <div
      className="consent-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.knowledge.pdfNotice.dialogAriaLabel')}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.45)',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="consent-dialog"
        style={{
          background: 'var(--card)',
          borderRadius: 'var(--r-sm)',
          padding: '24px',
          maxWidth: '440px',
          width: '90%',
          boxShadow: 'var(--shadow-modal)',
          display: 'grid',
          gap: 16,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 'var(--fs-8xl)', fontWeight: 600 }}>
          {t('settings.knowledge.pdfNotice.title')}
        </h2>
        <p style={{ margin: 0, fontSize: 'var(--fs-3xl)', color: 'var(--ink-2)', lineHeight: 1.6 }}>
          {t('settings.knowledge.pdfNotice.local')}
        </p>
        <p style={{ margin: 0, fontSize: 'var(--fs-3xl)', color: 'var(--ink-2)', lineHeight: 1.6 }}>
          {t('settings.knowledge.pdfNotice.imperfect')}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn ghost" type="button" onClick={onCancel}>
            {t('common.actions.cancel')}
          </button>
          <button className="btn primary" type="button" onClick={onContinue}>
            {t('common.actions.continue')}
          </button>
        </div>
      </div>
    </div>
  );
}
