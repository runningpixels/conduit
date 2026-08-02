import { Component, type ErrorInfo, type ReactNode } from 'react';

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
      return (
        <div className="doc-error-boundary" role="alert">
          <div className="doc-error-boundary-body">
            <p>
              <strong>Artifact preview error</strong>
            </p>
            <p className="doc-error-boundary-detail">
              The artifact preview encountered an error while rendering.
              {this.state.error?.message && (
                <span className="doc-error-boundary-message">
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