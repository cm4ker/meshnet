import { Component, type ReactNode } from "react";
import { Button } from "./Button.js";

/**
 * One screen's failure stays in that screen: the tabs, and Back, keep working.
 * Keyed by the screen it holds, so a new screen starts clean.
 */
export class ScreenBoundary extends Component<{ children: ReactNode; onBack?: (() => void) | undefined }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown) {
    console.error("A screen failed to draw", error);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="screen screen-failed" role="alert">
        <p>This screen could not be drawn.</p>
        <p className="muted mono">{error.message}</p>
        <div className="row-actions">
          {this.props.onBack ? <Button onClick={this.props.onBack}>Back</Button> : null}
          <Button onClick={() => this.setState({ error: null })}>Try again</Button>
        </div>
      </div>
    );
  }
}
