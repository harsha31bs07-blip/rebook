import { StoreError } from "../../store";
import { staffLogin } from "./requests";

const BASE = "https://api.mindbodyonline.com/public/v6/";
export function mindbodyEnabled(): boolean { return !!process.env.MINDBODY_API_KEY?.trim(); }
export class MindbodyError extends StoreError {
  constructor(public upstreamStatus: number, message: string) { super(502, message); }
}
type Options = { apiKey?: string; siteId?: number; username?: string; password?: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; maxCalls?: number };
const tokens = new Map<string, { token: string; until: number }>();
export class MindbodyClient {
  readonly siteId: number;
  calls = 0;
  private key: string;
  private username: string;
  private password: string;
  private token?: string;
  private tokenUntil = 0;
  private transport: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private maxCalls: number;
  private tokenKey: string;
  private usedTokens = new Set<string>();
  constructor(options: Options = {}) {
    this.key = options.apiKey ?? process.env.MINDBODY_API_KEY?.trim() ?? "";
    this.siteId = options.siteId ?? -99;
    this.username = options.username ?? process.env.MINDBODY_STAFF_USERNAME ?? (this.siteId === -99 ? "mindbodysandboxsite@gmail.com" : "");
    this.password = options.password ?? process.env.MINDBODY_STAFF_PASSWORD ?? (this.siteId === -99 ? "Apitest1234" : "");
    this.transport = options.fetch ?? fetch; this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxCalls = options.maxCalls ?? 300;
    this.tokenKey = JSON.stringify([this.key, this.siteId, this.username, this.password]);
    if (!options.fetch) { const cached = tokens.get(this.tokenKey); this.token = cached?.token; this.tokenUntil = cached?.until ?? 0; }
    if (this.token) this.usedTokens.add(this.token);
  }
  beginOperation(): void { this.calls = 0; }
  safeMessage(message: string): string {
    for (const secret of [this.key, this.password, ...this.usedTokens].filter((value): value is string => !!value)) message = message.split(secret).join("[redacted]");
    return message.slice(0, 500);
  }
  private async staffToken(): Promise<string> {
    if (this.token && this.tokenUntil > Date.now()) return this.token;
    if (!this.username || !this.password) throw new MindbodyError(401, "Mindbody staff credentials are required.");
    const result = await this.request<{ AccessToken: string }>("usertoken/issue", staffLogin(this.username, this.password), false);
    if (!result.AccessToken) throw new MindbodyError(401, "Mindbody did not issue a staff token.");
    this.token = result.AccessToken; this.tokenUntil = Date.now() + 30 * 60_000;
    this.usedTokens.add(this.token);
    tokens.set(this.tokenKey, { token: this.token, until: this.tokenUntil });
    return this.token;
  }
  async request<T>(path: string, body?: unknown, staff = true, retry = true): Promise<T> {
    if (!this.key) throw new StoreError(404, "Mindbody connector is disabled.");
    let refreshed = false, retried = false;
    for (;;) {
      const token = staff ? await this.staffToken() : undefined;
      if (++this.calls > this.maxCalls) throw new MindbodyError(429, "Mindbody call budget exceeded (300 calls per operation). Try a smaller location or retry later.");
      let response: Response;
      try {
        response = await this.transport(`${BASE}${path}`, { method: body === undefined ? "GET" : "POST", cache: "no-store", redirect: "error",
          headers: { "Api-Key": this.key, SiteId: String(this.siteId), Accept: "application/json", "Content-Type": "application/json", ...(token ? { Authorization: token } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
      } catch { throw new MindbodyError(502, "Mindbody could not be reached. Retry this operation."); }
      if (response.status === 401 && staff && !refreshed) { refreshed = true; this.token = undefined; tokens.delete(this.tokenKey); continue; }
      if ((response.status === 429 || (response.status >= 500 && retry)) && !retried) {
        retried = true; const seconds = Number(response.headers.get("Retry-After"));
        await this.sleep(Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 2000) : 250); continue;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.Error) throw new MindbodyError(response.status, this.safeMessage(data.Error?.Message ?? `Mindbody request failed (${response.status}).`));
      return data as T;
    }
  }
  async list<T>(path: string, field: string, query: Record<string, string | number> = {}): Promise<T[]> {
    const rows: T[] = []; let offset = 0;
    for (;;) {
      const params = new URLSearchParams(Object.entries({ ...query, Limit: 200, Offset: offset }).map(([key, value]) => [key, String(value)]));
      const result = await this.request<Record<string, unknown> & { PaginationResponse?: { TotalResults: number } }>(`${path}?${params}`);
      if (!Array.isArray(result[field])) throw new MindbodyError(502, `Mindbody response is missing ${field}.`);
      const page = result[field] as T[]; rows.push(...page); offset += page.length;
      if (result.PaginationResponse ? offset >= result.PaginationResponse.TotalResults : page.length < 200) return rows;
      if (!page.length) throw new MindbodyError(502, "Mindbody pagination stopped before the last page.");
    }
  }
}
export function mindbodyClient(): MindbodyClient {
  return new MindbodyClient();
}
