import { Component, type ReactNode } from "react";

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error("[tagteam2] render error:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="min-h-svh bg-background text-foreground p-6">
          <p>Something went wrong.</p>
          {this.state.error && (
            <p className="text-muted-foreground text-sm">{this.state.error.message}</p>
          )}
          <button
            onClick={() => window.location.reload()}
            className="mt-3 px-4 py-2 rounded bg-primary text-primary-foreground"
          >
            Reload
          </button>
        </main>
      );
    }
    return this.props.children;
  }
}
