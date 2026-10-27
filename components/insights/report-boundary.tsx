"use client";

import { Component, type ReactNode } from "react";

export class ReportBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <div className="insight-loading" role="alert"><p>The Studio report could not open. Try loading it again.</p>
      <button onClick={() => this.setState({ failed: false })}>Try again</button></div> : this.props.children;
  }
}
