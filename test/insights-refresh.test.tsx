import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { observeInsights } from "../lib/insights/refresh";
import { ReportBoundary } from "../components/insights/report-boundary";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup() {
  vi.useFakeTimers();
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  const callbacks = { data: vi.fn(), error: vi.fn(), expired: vi.fn(), loading: vi.fn() };
  const fetch = vi.fn().mockImplementation(async () => Response.json({ studio: { name: "Fresh records" } }));
  vi.stubGlobal("fetch", fetch);
  const observer = observeInsights("workspace", callbacks, win, doc);
  return { win, doc, callbacks, fetch, observer };
}

it("coalesces focus/visibility bursts, skips hidden tabs and refreshes on demand", async () => {
  const h = setup();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.fetch).toHaveBeenCalledTimes(1);
  for (let index = 0; index < 20; index += 1) {
    h.win.dispatchEvent(new Event("focus")); h.doc.dispatchEvent(new Event("visibilitychange"));
  }
  await vi.advanceTimersByTimeAsync(1499);
  expect(h.fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.fetch).toHaveBeenCalledTimes(2);
  h.doc.visibilityState = "hidden";
  h.doc.dispatchEvent(new Event("visibilitychange")); h.win.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(5000);
  expect(h.fetch).toHaveBeenCalledTimes(2);
  h.doc.visibilityState = "visible";
  h.doc.dispatchEvent(new Event("visibilitychange")); h.win.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(250);
  expect(h.fetch).toHaveBeenCalledTimes(3);
  await h.observer.refresh();
  expect(h.fetch).toHaveBeenCalledTimes(4);
  h.observer.destroy();
});

it("keeps one request in flight and cancels events, timers and late writes on unmount", async () => {
  const h = setup();
  await vi.advanceTimersByTimeAsync(0);
  let resolve!: (value: Response) => void;
  h.fetch.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
  const request = h.observer.refresh();
  await h.observer.refresh();
  h.win.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(2000);
  expect(h.fetch).toHaveBeenCalledTimes(2);
  const writes = h.callbacks.data.mock.calls.length;
  h.observer.destroy();
  expect(h.fetch.mock.calls[1][1].signal.aborted).toBe(true);
  resolve(Response.json({ late: true }));
  await request;
  expect(h.callbacks.data).toHaveBeenCalledTimes(writes);
  h.win.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(5000);
  expect(h.fetch).toHaveBeenCalledTimes(2);
});

it("recovers after failed refreshes and reports expired workspaces", async () => {
  const h = setup();
  await vi.advanceTimersByTimeAsync(0);
  h.fetch.mockResolvedValueOnce(Response.json({ error: "Temporary failure" }, { status: 503 }));
  await h.observer.refresh();
  expect(h.callbacks.error).toHaveBeenLastCalledWith("Temporary failure");
  await h.observer.refresh();
  expect(h.callbacks.error).toHaveBeenLastCalledWith("");
  expect(h.callbacks.data).toHaveBeenCalledTimes(2);
  h.fetch.mockResolvedValueOnce(Response.json({ code: "expired" }, { status: 410 }));
  await h.observer.refresh();
  expect(h.callbacks.expired).toHaveBeenCalledOnce();
  h.observer.destroy();
});

it("refreshes once more when a tab returns during an older in-flight request", async () => {
  const h = setup();
  await vi.advanceTimersByTimeAsync(0);
  let resolve!: (value: Response) => void;
  h.fetch.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
  const request = h.observer.refresh();
  h.win.dispatchEvent(new Event("focus")); h.doc.dispatchEvent(new Event("visibilitychange"));
  resolve(Response.json({ oldSnapshot: true }));
  await request;
  await vi.advanceTimersByTimeAsync(1500);
  expect(h.fetch).toHaveBeenCalledTimes(3);
  h.observer.destroy();
});

it("clears a scheduled refresh on unmount", async () => {
  const h = setup();
  await vi.advanceTimersByTimeAsync(0);
  h.win.dispatchEvent(new Event("focus"));
  h.observer.destroy();
  await vi.advanceTimersByTimeAsync(5000);
  expect(h.fetch).toHaveBeenCalledOnce();
});

it("renders a recoverable report failure and remounts children when retried", () => {
  const child = createElement("p", null, "Report");
  const boundary = new ReportBoundary({ children: child });
  boundary.state = ReportBoundary.getDerivedStateFromError();
  expect(renderToStaticMarkup(boundary.render())).toContain("Try again");
  expect(renderToStaticMarkup(boundary.render())).toContain('role="alert"');
  boundary.setState = (next) => { boundary.state = next as { failed: boolean }; };
  const fallback = boundary.render() as React.ReactElement<{ children: React.ReactElement[] }>;
  (fallback.props.children[1] as React.ReactElement<{ onClick(): void }>).props.onClick();
  expect(boundary.render()).toBe(child);
});
