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
 * Catches render errors inside the chat thread so a bad message or tool card
 * doesn't crash the entire app. Shows a user-friendly fallback with a Retry
 * button that resets the boundary.
 */
export class ChatErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ChatErrorBoundary] Caught render error:', error, errorInfo);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return <ChatErrorFallback error={this.state.error} onRetry={this.handleRetry} />;
    }

    return this.props.children;
  }
}

/** A class component's `render()` cannot call hooks itself, so the fallback
 *  markup — and the `useT()` call it needs — lives in this function component. */
function ChatErrorFallback({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="chat-error-boundary" role="alert">
      <div className="chat-error-boundary-body">
        <p>
          <strong>{t('chat.errorBoundary.title')}</strong>
        </p>
        <p className="chat-error-boundary-detail">
          {t('chat.errorBoundary.detail')}
          {error?.message && (
            <span className="chat-error-boundary-message">
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
