// Browser end-to-end check of the judge path on a deployed Rebook (real PayPal sandbox).
//   node scripts/e2e-judge-path.mjs [base-url]      (needs Chromium: npx playwright install chromium)
// Owner (desktop): interpret -> plan -> approve (refunds) -> outbox. Customer (phone): private link -> refund ->
// receipt. Substitute (phone): accept the cover, then a sandbox PayPal payout. Dashboard reflects the customer's refund. Public booking page: card checkout. Every page: axe audit of
// our own markup (Bryntum grid and AG Charts internals are reported but not fatal; AG Studio's trial watermark is excluded). Exits non-zero on any failure.
import { chromium, devices } from "playwright-core";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const BASE = (process.argv[2] || process.env.JUDGE_SMOKE_BASE || "https://rebook-by9u.onrender.com").replace(/\/$/, "");
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
// Known findings inside Bryntum / AG Studio markup. Excused only when every flagged node sits inside that markup.
const LIBRARY_RULES = new Set(["aria-required-children", "landmark-unique"]);
const LIBRARY_ROOTS = ".b-widget, .b-grid-base, [class^='ag-'], [class*=' ag-']";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const steps = [];
const step = async (name, run) => {
  const started = Date.now();
  try { const detail = await run(); steps.push({ name, ok: true, ms: Date.now() - started, ...(detail ? { detail } : {}) }); }
  catch (error) { steps.push({ name, ok: false, ms: Date.now() - started, error: String(error?.message ?? error).split("\n")[0] }); throw error; }
};
const api = async (method, path) => {
  const response = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", Origin: BASE }, body: method === "POST" ? "{}" : undefined });
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
  return response.json();
};
async function audit(page, name) {
  await sleep(2500); // let entry animations settle; mid-fade text briefly fails contrast
  await page.addScriptTag({ content: AXE });
  const found = await page.evaluate(async (roots) => (await window.axe.run({ exclude: [[".ag-studio-watermark-text"]] }, { resultTypes: ["violations"] })).violations.map((v) => ({ id: v.id, html: v.nodes[0]?.html.slice(0, 160),
    vendor: v.nodes.every((node) => typeof node.target[0] === "string" && !!document.querySelector(node.target[0])?.closest(roots)) })), LIBRARY_ROOTS);
  const library = (v) => LIBRARY_RULES.has(v.id) && v.vendor;
  const ours = found.filter((v) => !library(v)).map((v) => `${v.id} at ${v.html}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (ours.length) throw new Error(`${name}: accessibility violations ${ours.join(", ")}`);
  if (overflow > 1) throw new Error(`${name}: horizontal overflow ${overflow}px`);
  return { library: found.filter(library).map((v) => v.id) };
}

let browser;
try {
  for (let i = 0; i < 60; i += 1) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(3000); }
  let workspace;
  await step("create demo workspace", async () => {
    let created;
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${BASE}/api/workspaces`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: "{}" });
      if (response.status === 429 && attempt < 3) { await sleep(Math.min(Number(response.headers.get("retry-after")) || 30, 300) * 1000); continue; }
      if (!response.ok) throw new Error(`POST /api/workspaces: HTTP ${response.status}`);
      created = await response.json(); break;
    }
    for (let i = 0; i < 120; i += 1) { workspace = await api("GET", `/api/workspaces/${created.id}`); if (workspace.status !== "preparing") break; await sleep(1000); }
    if (workspace.status !== "ready") throw new Error(`workspace ${workspace.status}`);
  });
  const id = workspace.id;
  browser = await chromium.launch();
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, bypassCSP: true });
  await desk.addInitScript(() => { try { localStorage.setItem("rebook:judge-hint:dismissed", "1"); } catch {} });
  const owner = await desk.newPage();
  await step("owner console loads", async () => { await owner.goto(`${BASE}/w/${id}`); await owner.locator(".b-sch-event").first().waitFor({ timeout: 45000 }); return audit(owner, "console"); });
  await step("interpret the disruption", async () => {
    await owner.getByRole("textbox").first().fill("Maya has the flu and can't teach Monday");
    await owner.getByRole("button", { name: /^Understand disruption$/ }).click();
    await owner.getByRole("button", { name: /^Plan recovery$/ }).first().waitFor({ timeout: 60000 });
    return { source: await owner.locator(".understood-card .pill").first().innerText().catch(() => "?") };
  });
  await step("plan the recovery (9 kept / 16 moved / 6 refunds)", async () => {
    await owner.getByRole("button", { name: /^Plan recovery$/ }).first().click();
    await owner.getByRole("button", { name: /Approve and refund/i }).first().waitFor({ timeout: 60000 });
    const text = await owner.locator("body").innerText();
    for (const [label, value] of [["Kept", "9"], ["Moved", "16"], ["Refunds planned", "6"]]) {
      if (!new RegExp(`${label}\\s*\\n\\s*${value}\\b`).test(text)) throw new Error(`plan totals: ${label} != ${value}`);
    }
    if (!text.includes("$577.00")) throw new Error("plan revenue kept != $577.00");
    return audit(owner, "plan");
  });
  await step("approve and refund through PayPal", async () => {
    await owner.getByRole("button", { name: /Approve and refund/i }).first().click();
    const dialog = owner.getByRole("dialog");
    if (await dialog.isVisible({ timeout: 3000 }).catch(() => false)) await dialog.getByRole("button", { name: /confirm approval/i }).click();
    for (let i = 0; i < 90; i += 1) {
      const ws = await api("GET", `/api/workspaces/${id}`);
      const refunds = ws.ledger.filter((event) => event.kind === "refund" && event.status === "COMPLETED");
      if (refunds.length >= 6) return { completedRefunds: refunds.length };
      await sleep(2000);
    }
    throw new Error("six refunds did not complete within 3 minutes");
  });
  await step("customer outbox lists every affected customer", async () => {
    await owner.getByRole("button", { name: /Customer messages/i }).first().click();
    await owner.getByRole("dialog").waitFor({ timeout: 15000 });
    const rows = await owner.getByRole("dialog").getByRole("button", { name: /WhatsApp/i }).count();
    if (rows < 20) throw new Error(`outbox shows ${rows} WhatsApp actions`);
    const result = await audit(owner, "outbox");
    await owner.keyboard.press("Escape");
    return { rows, ...result };
  });
  const ws = await api("GET", `/api/workspaces/${id}`);
  const link = ws.customerChoices.links.find((item) => item.kind === "choice");
  const phone = await browser.newContext({ ...devices["iPhone 13"], bypassCSP: true });
  const customer = await phone.newPage();
  await step("customer takes a refund from the private link (phone)", async () => {
    await customer.goto(BASE + link.path);
    await customer.getByRole("button", { name: /Refund me/i }).waitFor({ timeout: 30000 });
    await audit(customer, "choice");
    await customer.getByRole("button", { name: /Refund me/i }).click();
    const confirm = customer.getByRole("button", { name: /Confirm|Yes, refund/i }).first();
    if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) await confirm.click();
    await customer.getByText(/Refund completed/i).first().waitFor({ timeout: 90000 });
  });
  await step("substitute accepts the cover and is paid with PayPal Payouts (phone)", async () => {
    const cover = (await api("GET", `/api/workspaces/${id}`)).covers?.[0];
    if (!cover) throw new Error("no cover link after approval");
    await customer.goto(BASE + cover.path);
    await customer.getByRole("button", { name: /cover it/i }).waitFor({ timeout: 30000 });
    await audit(customer, "cover");
    await customer.getByRole("button", { name: /cover it/i }).click();
    await customer.getByText(/You’re teaching this class/).waitFor({ timeout: 20000 });
    const response = await fetch(`${BASE}/api/workspaces/${id}/covers/pay`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE },
      body: JSON.stringify({ planId: cover.planId, sessionId: cover.sessionId }) });
    if (!response.ok) throw new Error(`pay cover: HTTP ${response.status}`);
    const paid = (await response.json()).find((item) => item.sessionId === cover.sessionId);
    if (!["PENDING", "SUCCESS"].includes(paid?.payout?.status)) throw new Error(`payout status ${paid?.payout?.status}`);
    return { payout: paid.payout.status };
  });
  await step("dashboard reflects the customer's refund", async () => {
    await owner.goto(`${BASE}/w/${id}/dashboard`);
    await owner.getByText(/Kept or moved/i).first().waitFor({ timeout: 45000 });
    const text = await owner.locator("body").innerText();
    if (!/Refunded\s*\n\s*7\b/.test(text)) throw new Error("dashboard does not show 7 refunded after the customer's refund");
    return audit(owner, "dashboard");
  });
  await step("public booking page checkout with a sandbox card", async () => {
    const page = await desk.newPage();
    await page.goto(`${BASE}/b/${ws.bookingId}`);
    if ((await page.content()).includes(id)) throw new Error("owner workspace id appears on the public booking page");
    await page.locator("button", { hasText: "Pilates Flow" }).first().click();
    await page.getByLabel(/name/i).first().fill("Jamie Rivera");
    await page.getByLabel(/email/i).first().fill("jamie@example.com");
    const fill = async (field, value) => {
      const input = page.frameLocator(`[data-card="${field}"] iframe`).locator("input").first();
      await input.waitFor({ timeout: 45000 }); await input.click(); await input.pressSequentially(value, { delay: 40 });
    };
    await fill("number", "4111111111111111"); await fill("expiry", "1230"); await fill("cvv", "123");
    await page.getByRole("button", { name: /^Pay \$/ }).click();
    try { await page.getByText(/Booking confirmed|You.re on the list/i).first().waitFor({ timeout: 90000 }); }
    catch (error) {
      // Report what the buyer saw (error text, PayPal challenge frames) instead of a bare timeout.
      const alerts = await page.getByRole("alert").allInnerTexts().catch(() => []);
      const frames = page.frames().map((frame) => new URL(frame.url() || "about:blank").hostname).filter(Boolean);
      if (process.env.E2E_ARTIFACTS) await page.screenshot({ path: `${process.env.E2E_ARTIFACTS}/checkout-failure.png`, fullPage: true }).catch(() => {});
      throw new Error(`checkout not confirmed; alerts: ${JSON.stringify(alerts).slice(0, 300)}; frames: ${[...new Set(frames)].join(",")}; ${String(error.message).split("\n")[0]}`);
    }
    return audit(page, "booking");
  });
  console.log(JSON.stringify({ ok: true, base: BASE, workspaceId: id, steps }));
} catch {
  console.log(JSON.stringify({ ok: false, base: BASE, steps }));
  process.exitCode = 1;
} finally {
  await browser?.close();
}
