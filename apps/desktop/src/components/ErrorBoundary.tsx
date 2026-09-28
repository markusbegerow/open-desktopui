import { Component, ErrorInfo, ReactNode } from "react";
import { logError } from "../lib/log";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// Last-resort net for an uncaught render error, which would otherwise
// white-screen the entire app with nothing on screen to explain why (no
// error boundary existed anywhere before this). Deliberately minimal — this
// isn't a recoverable-error system, just a fallback screen plus a reload.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    logError(`Uncaught render error: ${error.stack ?? error.message}\n${info.componentStack ?? ""}`);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="login-view">
        <div className="login-card">
          <h1>Something went wrong</h1>
          <p className="hint">
            Open DesktopUI hit an unexpected error and couldn't continue. Reloading usually fixes it —
            your chat history and settings are unaffected.
          </p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => navigator.clipboard.writeText(`${error.stack ?? error.message}`)}
          >
            Copy error details
          </button>
        </div>
      </div>
    );
  }
}
