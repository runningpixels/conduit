import { useT } from '../../i18n';
import { openExternalUrl } from '../../ipc/client';
import type { ResearchSource, ResearchSourceStatus } from '../../ipc/contracts';

const STATUS_ID: Record<ResearchSourceStatus, string> = {
  read: 'chat.research.source.read',
  empty: 'chat.research.source.empty',
  failed: 'chat.research.source.failed',
  skipped: 'chat.research.source.skipped',
};

interface ResearchSourcesProps {
  sources: ResearchSource[];
  onError?: (message: string) => void;
}

/** Every page the run looked at, collapsed: title, host, whether it was read, and its footnote in the report. */
export function ResearchSources({ sources, onError }: ResearchSourcesProps) {
  const t = useT();
  if (sources.length === 0) return null;

  async function open(url: string) {
    try {
      await openExternalUrl(url);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <details className="research-sources">
      <summary>{t('chat.research.sources.summary', { count: sources.length })}</summary>
      <ul className="research-source-list">
        {sources.map((source) => (
          <li key={source.id} className="research-source" data-status={source.status}>
            {source.footnote != null && <span className="research-source-note">[{source.footnote}]</span>}
            <a
              className="source-link"
              href={source.url}
              title={source.url}
              onClick={(event) => {
                event.preventDefault();
                void open(source.url);
              }}
            >
              <span className="source-link-title">{source.title || source.host}</span>
              <span className="source-link-host">{source.host}</span>
            </a>
            <span className="research-source-status">{t(STATUS_ID[source.status])}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
