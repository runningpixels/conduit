import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useT } from '../i18n';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Catches render errors inside the artifact preview panel so a bad artifact
 * payload or renderer crash doesn't crash the entire app. Shows a user-friendly
 * fallback with a Retry button that resets the boundary.
 */
export class DocumentPanelErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[DocumentPanelErrorBoundary] Caught render error:', error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return <DocumentPanelErrorFallback error={this.state.error} onRetry={this.handleRetry} />;
    }

    return this.props.children;
  }
}

/** A class component's `render()` cannot call hooks itself, so the fallback
 *  markup — and the `useT()` call it needs — lives in this function component. */
function DocumentPanelErrorFallback({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="doc-error-boundary" role="alert">
      <div className="doc-error-boundary-body">
        <p>
          <strong>{t('artifacts.errorBoundary.title')}</strong>
        </p>
        <p className="doc-error-boundary-detail">
          {t('artifacts.errorBoundary.detail')}
          {error?.message && (
            <span className="doc-error-boundary-message">
              {' '}
              ({error.message})
            </span>
          )}
        </p>
        <button
          className="btn"
          type="button"
          onClick={onRetry}
        >
          {t('common.actions.retry')}
        </button>
      </div>
    </div>
  );
}