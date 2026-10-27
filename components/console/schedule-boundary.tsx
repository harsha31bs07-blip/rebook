"use client";

import { Component, type ReactNode } from "react";
import ScheduleAgenda, { type AgendaProps } from "./schedule-agenda";

export function ScheduleFallback(props: AgendaProps) {
  return <div className="schedule-fallback">
    <p role="status">The interactive timeline is unavailable in this browser. Your week and recovery plan are listed below.</p>
    <ScheduleAgenda {...props} />
  </div>;
}

export class ScheduleBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
