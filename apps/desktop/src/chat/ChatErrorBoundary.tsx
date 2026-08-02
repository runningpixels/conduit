import { Component, type ErrorInfo, type ReactNode } from 'react';

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
      return (
        <div className="chat-error-boundary" role="alert">
          <div className="chat-error-boundary-body">
            <p>
              <strong>Something went wrong</strong>
            </p>
            <p className="chat-error-boundary-detail">
              The chat thread encountered an error while rendering.
              {this.state.error?.message && (
                <span className="chat-error-boundary-message">
                  {' '}
                  ({this.state.error.message})
                </span>
              )}
            </p>
            <button
              className="btn"
              type="button"
              onClick={this.handleRetry}
            >
              Retry
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}