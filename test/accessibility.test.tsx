import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { adjustmentFixture } from "./adjust-fixture";

vi.mock("next/link", () => ({ default: "a" }));
vi.mock("next/script", () => ({ default: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/console/open-demo-button", () => import("../components/console/open-demo-button"));
vi.mock("@/lib/client/api", () => import("../lib/client/api"));
vi.mock("@/lib/client/scheduler-mapping", () => import("../lib/client/scheduler-mapping"));
vi.mock("@/lib/client/paypal-v6", () => import("../lib/client/paypal-v6"));
vi.mock("@/lib/domain/time", () => import("../lib/domain/time"));
vi.mock("../lib/webmcp/use-webmcp", () => ({ useWebMcp: () => {} }));
vi.mock("../components/console/use-workspace", () => ({ useWorkspace: () => ({ workspace: {
  state: adjustmentFixture(), plans: [], status: "ready", progress: { done: 1, total: 1 },
}, refresh: vi.fn() }) }));
import Home from "../app/page";
import AgentReadyPage from "../app/agent-ready/page";
import BookingPage from "../components/booking/booking-page";
import CustomerChoicePage from "../components/booking/customer-choice-page";
import OwnerConsole from "../components/console/owner-console";
import Dashboard from "../components/insights/dashboard";

it.each([
  ["landing", <Home key="landing" />], ["agent-ready", <AgentReadyPage key="agent-ready" />],
  ["booking", <BookingPage key="booking" id="workspace" clientId="" sandbox />],
  ["customer choice", <CustomerChoicePage key="choice" token="private" />],
  ["console", <OwnerConsole key="console" id="workspace" />], ["dashboard shell", <Dashboard key="dashboard" id="workspace" />],
])("%s has a focusable skip-link target, ordered headings and named controls", (_name, page) => {
  const html = renderToStaticMarkup(page);
  expect(html).toMatch(/<main[^>]*id="main-content"[^>]*tabindex="-1"/i);
  const headings = [...html.matchAll(/<h([1-6])\b/g)].map((match) => Number(match[1]));
  expect(headings[0]).toBe(1);
  headings.forEach((level, index) => { if (index) expect(level).toBeLessThanOrEqual(headings[index - 1] + 1); });
  for (const control of html.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const label = control[2].match(/aria-label="([^"]+)"/)?.[1] ?? control[3].replace(/<[^>]+>/g, "").trim();
    expect(label, control[0]).not.toBe("");
  }
  for (const field of html.matchAll(/<(input|textarea|select)\b([^>]*)>/g)) {
    const id = field[2].match(/id="([^"]+)"/)?.[1];
    expect(Boolean(field[2].match(/aria-label="[^"]+"/)) || Boolean(id && html.includes(`for="${id}"`)), field[0]).toBe(true);
  }
});

function luminance(hex: string) {
  const values = hex.slice(1).match(/../g)!.map((pair) => parseInt(pair, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}
function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

it("keeps muted text, status badges and class labels above 4.5:1 contrast", () => {
  const css = readFileSync("app/globals.css", "utf8");
  const muted = css.match(/--muted:\s*(#[\da-f]{6})/)![1];
  for (const background of ["#ffffff", "#f8fafc", "#eff6ff", "#edf4eb"]) expect(contrast(muted, background)).toBeGreaterThanOrEqual(4.5);
  const selectors = ["success-pill", "action-keep", "action-move", "action-refund", "receipt-completed", "receipt-pending", "receipt-simulated", "receipt-failed", "warning", "notice", "class-yoga", "class-pilates", "class-spin", "class-dance", "class-hiit", "class-barre"];
  for (const selector of selectors) {
    const rule = [...css.matchAll(new RegExp(`\\.${selector}[^{}]*\\{([^}]+)\\}`, "g"))]
      .map((match) => match[1]).find((value) => /(?:^|;)\s*color:\s*#[\da-f]{6}/.test(value))!;
    const color = rule.match(/(?:^|;)[\s]*color:\s*(#[\da-f]{6})/)![1];
    const background = rule.match(/background(?:-color)?:\s*(#[\da-f]{6})/)![1];
    expect(contrast(color, background), selector).toBeGreaterThanOrEqual(4.5);
  }
});

it("renders the global skip link and retains reduced-motion and universal focus protections", () => {
  const layout = readFileSync("app/layout.tsx", "utf8");
  const css = readFileSync("app/globals.css", "utf8");
  expect(layout).toContain('href="#main-content">Skip to main content');
  expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid/);
  expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
  expect(css).toMatch(/\.move-to-popover\s*\{[^}]*inset:\s*0;[^}]*margin:\s*auto;/);
});
