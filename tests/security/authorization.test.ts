/**
 * V010-008 — defensive local authorization tests (SPEC-001 Revision 7 §6, §12).
 *
 * Scope: local, synthetic fixtures only. No credentials, no live OAuth, no deployment.
 *
 * The production Worker must expose a normal `apiHandler` export (the handler that
 * `OAuthProvider` dispatches to for `/mcp`) so the same authorization code can be
 * exercised without a test-only route or bypass flag. The entry-point checks below
 * always run; the handler-level suite runs once that seam exists.
 *
 * Runtime contract expected by this file:
 *   - default export: Worker fetch handler for the public entry point.
 *   - named export `apiHandler`: `{ fetch(request, env, ctx) }` used by OAuthProvider.
 *   - `ctx.props`:  { githubUserId, scopes, resource } from the authorization grant.
 *   - `ctx.auth`:   { scope|scopes, audience, expiresAt } from the validated token.
 *   - env: GITHUB_OWNER_ID, REQUIRED_SCOPE, ALLOWED_ORIGINS (comma-separated)
 *          or ALLOWED_ORIGIN (single value), and MCP_RESOURCE (canonical
 *          `.../mcp` URL). The fixture supplies both Origin variable names so
 *          the runtime may choose either shape.
 *   - all /mcp outcomes (success and denial) carry `Cache-Control` containing
 *     `no-store`; handler-origin denials also carry `private`.
 *
 * The expected handler behavior mirrors the reviewed spike in
 * `spike/worker.ts`: owner ID, required scope, resource binding, token expiry and
 * Origin are checked before the MCP SDK sees the request. The spike's
 * `SPIKE_MODE`, `bypass_auth_check`, `test_github_id`, `test_scopes` and
 * `test_resource` knobs must not be copied into the production runtime.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const OWNER_ID = "42424242";
const NON_OWNER_ID = "99999999";
const REQUIRED_SCOPE = "catalog:read";
const MCP_RESOURCE = "https://ega-plugin.test/mcp";
const ALLOWED_ORIGIN = "https://allowed.example.test";
const DISALLOWED_ORIGIN = "https://evil.example.test";
const NOW_SECONDS = Math.floor(Date.now() / 1_000);

interface SyntheticEnv {
  GITHUB_OWNER_ID: string;
  REQUIRED_SCOPE: string;
  ALLOWED_ORIGINS: string;
  ALLOWED_ORIGIN: string;
  MCP_RESOURCE: string;
  OAUTH_KV: KVNamespace;
}

interface SyntheticProps {
  githubUserId: string;
  login: string;
  scopes: string[];
  resource: string;
}

interface SyntheticAuth {
  token: string;
  clientId: string;
  scope: string[];
  scopes: string[];
  audience: string;
  userId: string;
  expiresAt: number;
}

type SyntheticContext = Omit<ExecutionContext, "props"> & {
  props?: SyntheticProps;
  auth?: SyntheticAuth;
};

type FetchHandler = (
  request: Request,
  env: SyntheticEnv,
  ctx: SyntheticContext
) => Response | Promise<Response>;

interface RuntimeModule {
  default?: unknown;
  apiHandler?: unknown;
  [key: string]: unknown;
}

const runtime = (await import("../../src/index")) as unknown as RuntimeModule;

function toFetchHandler(candidate: unknown): FetchHandler | undefined {
  if (typeof candidate === "function") return candidate as FetchHandler;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { fetch?: unknown }).fetch === "function"
  ) {
    return (candidate as { fetch: FetchHandler }).fetch.bind(candidate);
  }
  return undefined;
}

const entrypoint = toFetchHandler(runtime.default);
const apiHandler = toFetchHandler(runtime.apiHandler);

function kvStub(): KVNamespace {
  return {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

function testEnv(): SyntheticEnv {
  return {
    GITHUB_OWNER_ID: OWNER_ID,
    REQUIRED_SCOPE,
    ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    ALLOWED_ORIGIN,
    MCP_RESOURCE,
    OAUTH_KV: kvStub(),
  };
}

function testCtx(options?: {
  props?: SyntheticProps | undefined;
  auth?: SyntheticAuth | undefined;
}): SyntheticContext {
  return {
    props: options?.props,
    auth: options?.auth,
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as SyntheticContext;
}

function ownerProps(overrides?: Partial<SyntheticProps>): SyntheticProps {
  return {
    githubUserId: OWNER_ID,
    login: "owner",
    scopes: [REQUIRED_SCOPE],
    resource: MCP_RESOURCE,
    ...overrides,
  };
}

function ownerAuth(overrides?: Partial<SyntheticAuth>): SyntheticAuth {
  return {
    token: "synthetic-token",
    clientId: "synthetic-client",
    scope: [REQUIRED_SCOPE],
    scopes: [REQUIRED_SCOPE],
    audience: MCP_RESOURCE,
    userId: OWNER_ID,
    expiresAt: NOW_SECONDS + 3_600,
    ...overrides,
  };
}

function mcpRequest(headers?: Record<string, string>): Request {
  return new Request(MCP_RESOURCE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "skills/list",
      params: {},
    }),
  });
}

async function callEntrypoint(
  request: Request,
  options?: { props?: SyntheticProps; auth?: SyntheticAuth }
): Promise<Response> {
  if (!entrypoint) throw new Error("Worker default export is not callable");
  return await entrypoint(request, testEnv(), testCtx(options));
}

async function callApiHandler(
  request: Request,
  options?: { props?: SyntheticProps; auth?: SyntheticAuth }
): Promise<Response> {
  if (!apiHandler) {
    throw new Error(
      "V010-008 integration need: export `apiHandler` from src/index.ts so the " +
        "OAuthProvider-dispatched authorization path can be tested without a bypass."
    );
  }
  return await apiHandler(request, testEnv(), testCtx(options));
}

function expectNoCatalogLeak(body: string): void {
  expect(body).not.toContain("skill-");
  expect(body).not.toContain('"skills"');
  expect(body).not.toContain("resources/read");
}

function expectPrivateNoStore(response: Response): void {
  expect(response.headers.get("cache-control")?.toLowerCase()).toContain("no-store");
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("V010-008 fail-closed entry point", () => {
  it("does not serve MCP content without authorization", async () => {
    const response = await callEntrypoint(mcpRequest());

    expect([401, 404]).toContain(response.status);
    if (response.status === 401) {
      expect(response.headers.get("www-authenticate")?.toLowerCase()).toContain("bearer");
    }
    expectPrivateNoStore(response);
    expectNoCatalogLeak(await response.text());
  });

  it("ignores test-only bypass parameters instead of authorizing them", async () => {
    const response = await callEntrypoint(
      mcpRequest({
        origin: DISALLOWED_ORIGIN,
        "x-test-owner": OWNER_ID,
      })
    );

    expect(response.status).not.toBe(200);
    expectPrivateNoStore(response);
    expectNoCatalogLeak(await response.text());

    const bypass = await callEntrypoint(
      new Request(`${MCP_RESOURCE}?bypass_auth_check=1&test_github_id=${OWNER_ID}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          origin: ALLOWED_ORIGIN,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "skills/list", params: {} }),
      })
    );

    expect(bypass.status).not.toBe(200);
    expectNoCatalogLeak(await bypass.text());
  });

  it("exposes the handler seam once the protected MCP runtime exists", async () => {
    const probe = await callEntrypoint(mcpRequest());
    const runtimeIsIntegrated = probe.status !== 404;

    if (runtimeIsIntegrated) {
      expect(
        apiHandler,
        "V010-008 integration need: export `apiHandler` from src/index.ts so " +
          "owner/scope/resource/expiry/Origin checks can be tested without a bypass."
      ).toBeDefined();
    }
  });

  it("keeps the production runtime free of test bypass knobs", () => {
    const forbidden = [
      "SPIKE_MODE",
      "bypass_auth_check",
      "test_github_id",
      "test_scopes",
      "test_resource",
    ];
    const sourceRoot = join(process.cwd(), "src");
    const findings = walkFiles(sourceRoot).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return forbidden
        .filter((needle) => source.includes(needle))
        .map((needle) => `${file.replace(process.cwd(), ".")}: ${needle}`);
    });

    expect(findings).toEqual([]);
  });
});

const describeHandler = apiHandler ? describe : describe.skip;

describeHandler("V010-008 authorization handler", () => {
  it("rejects a request with no authorization context", async () => {
    const response = await callApiHandler(mcpRequest());

    expect(response.status).toBe(401);
    expectPrivateNoStore(response);
    expectNoCatalogLeak(await response.text());
  });

  it("rejects a non-owner identity", async () => {
    const response = await callApiHandler(mcpRequest(), {
      props: ownerProps({ githubUserId: NON_OWNER_ID }),
      auth: ownerAuth({ userId: NON_OWNER_ID }),
    });

    expect(response.status).toBe(403);
    expectPrivateNoStore(response);
    expectNoCatalogLeak(await response.text());
  });

  it("rejects an owner token missing the required read scope", async () => {
    const response = await callApiHandler(mcpRequest(), {
      props: ownerProps({ scopes: ["other:scope"] }),
      auth: ownerAuth({ scope: ["other:scope"], scopes: ["other:scope"] }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate") ?? "").toContain("insufficient_scope");
    expectPrivateNoStore(response);
    expectNoCatalogLeak(await response.text());
  });

  it("rejects a token authorized for a different resource", async () => {
    const response = await callApiHandler(mcpRequest(), {
      props: ownerProps({ resource: "https://other.example.test/mcp" }),
      auth: ownerAuth({ audience: "https://other.example.test/mcp" }),
    });

    expect(response.status).toBe(403);
    expectPrivateNoStore(response);
    expectNoCatalogLeak(await response.text());
  });

  it("rejects an expired authorization context", async () => {
    const response = await callApiHandler(mcpRequest(), {
      props: ownerProps(),
      auth: ownerAuth({ expiresAt: NOW_SECONDS - 1 }),
    });

    expect(response.status).not.toBe(200);
    expect([401, 403]).toContain(response.status);
    expectPrivateNoStore(response);
    expectNoCatalogLeak(await response.text());
  });

  it("rejects an authorization context without a usable expiry", async () => {
    const response = await callApiHandler(mcpRequest(), {
      props: ownerProps(),
      auth: ownerAuth({ expiresAt: Number.NaN }),
    });

    expect(response.status).not.toBe(200);
    expectPrivateNoStore(response);
    expectNoCatalogLeak(await response.text());
  });

  it("rejects malformed and disallowed Origin values before dispatch", async () => {
    for (const origin of ["not-a-valid-origin", DISALLOWED_ORIGIN]) {
      const response = await callApiHandler(mcpRequest({ origin }), {
        props: ownerProps(),
        auth: ownerAuth(),
      });

      expect(response.status).toBe(403);
      expectPrivateNoStore(response);
      expectNoCatalogLeak(await response.text());
    }
  });

  it("still enforces authorization when Origin is absent", async () => {
    const response = await callApiHandler(mcpRequest(), {
      props: ownerProps({ githubUserId: NON_OWNER_ID }),
      auth: ownerAuth({ userId: NON_OWNER_ID }),
    });

    expect(response.status).toBe(403);
    expectPrivateNoStore(response);
  });

  it("accepts an allowed Origin with a valid owner context and stays private", async () => {
    const response = await callApiHandler(mcpRequest({ origin: ALLOWED_ORIGIN }), {
      props: ownerProps(),
      auth: ownerAuth(),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")?.toLowerCase()).toContain("no-store");
    expect(response.headers.get("cache-control")?.toLowerCase()).toContain("private");
  });
});
