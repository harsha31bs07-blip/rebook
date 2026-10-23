import { vi } from "vitest";
import type { Configuration } from "@paypal/paypal-server-sdk";

type Transport = (url: string, init: RequestInit) => Promise<Response>;
const stub = vi.hoisted(() => ({ send: undefined as Transport | undefined }));

// Exercise the real SDK serializers, OAuth cache, retries and error mapping, replacing only Axios I/O.
vi.mock("@paypal/paypal-server-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paypal/paypal-server-sdk")>();
  return { ...actual, Client: class extends actual.Client {
    constructor(config?: Partial<Configuration>) {
      super({ ...config, unstable_httpClientOptions: {
        adapter: async (request: { url: string; method: string; data?: string; headers: Record<string, string> }) => {
          if (!stub.send) throw new Error("Unexpected SDK HTTP request");
          const response = await stub.send(request.url, { method: request.method.toUpperCase(), body: request.data, headers: request.headers });
          return { data: await response.text(), status: response.status, statusText: response.statusText,
            headers: Object.fromEntries(response.headers), config: request };
        },
      } });
    }
  } };
});

export function setSdkTransport(send: Transport): void { stub.send = send; }
