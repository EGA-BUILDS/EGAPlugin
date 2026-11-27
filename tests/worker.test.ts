import { env as bindings } from "cloudflare:workers";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import releaseWorker from "../src/index";
import { describe, expect, it } from "vitest";
import type { RuntimeCatalog } from "../src/catalog";
import { createWorker, type Env, type EgaWorker } from "../src/worker";

const emptyCatalog: RuntimeCatalog = { skills: [], read: () => undefined };
const publicOrigin = "https://ega-plugin.test";

const env = {
  PUBLIC_ORIGIN: publicOrigin,
  GITHUB_CLIENT_ID: "local-test-client",
  GITHUB_CLIENT_SECRET: "synthetic-client-secret",
  GITHUB_OWNER_ID: "1",
  OAUTH_KV: {} as unknown as KVNamespace,
} as Env;

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

const fetchWorker = (
  worker: EgaWorker,
  path: string,
  init: RequestInit = {},
  requestEnv: Env = env
) => worker.fetch(new Request(`${publicOrigin}${path}`, init), requestEnv, ctx);

describe("worker entry", () => {
  const worker = createWorker(emptyCatalog);

  it("fails closed when public origin configuration is missing", async () => {
    const response = await fetchWorker(worker, "/mcp", {}, {
      ...env,
      PUBLIC_ORIGIN: "",
    } as Env);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.text()).resolves.toBe("Service unavailable");
  });

  it("fails closed when the owner identity is missing or invalid", async () => {
    for (const broken of [
      { ...env, GITHUB_OWNER_ID: "" },
      { ...env, GITHUB_OWNER_ID: "not-a-number" },
    ]) {
      const response = await fetchWorker(worker, "/mcp", {}, broken as Env);
      expect(response.status).toBe(503);
    }
  });

  it("refuses to start a new authorization without GitHub credentials", async () => {
    const response = await fetchWorker(worker, "/authorize", {}, {
      ...env,
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
    } as Env);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects a disallowed Origin with 403 before MCP dispatch", async () => {
    const response = await fetchWorker(worker, "/mcp", {
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects a malformed Origin with 403", async () => {
    const response = await fetchWorker(worker, "/mcp", {
      headers: { origin: "null" },
    });
    expect(response.status).toBe(403);
  });

  it("lets an allowed Origin reach authorization", async () => {
    const response = await fetchWorker(worker, "/mcp", {
      headers: { origin: publicOrigin },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("requires authorization when no Origin header is present", async () => {
    const response = await fetchWorker(worker, "/mcp");
    expect(response.status).toBe(401);
  });

  it("serves path-scoped protected-resource metadata", async () => {
    const response = await fetchWorker(worker, "/.well-known/oauth-protected-resource/mcp");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      resource: `${publicOrigin}/mcp`,
      scopes_supported: ["catalog:read"],
    });
  });

  it("uses the canonical resource URL when configured", async () => {
    const resource = "https://canonical.example/mcp";
    const response = await worker.fetch(
      new Request("https://canonical.example/.well-known/oauth-protected-resource/mcp"),
      { ...env, MCP_RESOURCE: resource } as Env,
      ctx
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ resource });
  });

  it("fails closed on a malformed canonical resource URL", async () => {
    const response = await fetchWorker(worker, "/mcp", {}, {
      ...env,
      MCP_RESOURCE: "https://canonical.example/not-mcp",
    } as Env);
    expect(response.status).toBe(503);
  });

  it("returns 404 with private no-store for unknown paths", async () => {
    const response = await fetchWorker(worker, "/health");
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("protected MCP authorization seam", () => {
  const worker = createWorker(emptyCatalog);
  const resource = `${publicOrigin}/mcp`;
  const request = () =>
    new Request(resource, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "skills/list", params: {} }),
    });
  const authorizedContext = (overrides?: {
    githubUserId?: string;
    scope?: string[];
    resource?: string;
    expiresAt?: number;
  }) =>
    ({
      props: {
        githubUserId: overrides?.githubUserId ?? "1",
        resource: overrides?.resource ?? resource,
        scopes: overrides?.scope ?? ["catalog:read"],
      },
      auth: {
        token: "synthetic",
        clientId: "synthetic",
        audience: overrides?.resource ?? resource,
        scope: overrides?.scope ?? ["catalog:read"],
        expiresAt: overrides?.expiresAt ?? 4_000_000_000,
      },
      waitUntil() {},
      passThroughOnException() {},
    }) as unknown as ExecutionContext;

  it("rejects a request without authorization context", async () => {
    const response = await worker.apiHandler.fetch(request(), env, ctx);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects a non-owner subject", async () => {
    const response = await worker.apiHandler.fetch(
      request(),
      env,
      authorizedContext({ githubUserId: "2" })
    );
    expect(response.status).toBe(403);
  });

  it("rejects a missing scope with an insufficient_scope challenge", async () => {
    const response = await worker.apiHandler.fetch(
      request(),
      env,
      authorizedContext({ scope: ["other:scope"] })
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain("insufficient_scope");
  });

  it("rejects a mismatched resource binding", async () => {
    const response = await worker.apiHandler.fetch(
      request(),
      env,
      authorizedContext({ resource: "https://other.example/mcp" })
    );
    expect(response.status).toBe(403);
  });

  it("rejects an expired token", async () => {
    const response = await worker.apiHandler.fetch(
      request(),
      env,
      authorizedContext({ expiresAt: 1 })
    );
    expect(response.status).toBe(403);
  });

  it("dispatches an authorized owner request to MCP", async () => {
    const response = await worker.apiHandler.fetch(request(), env, authorizedContext());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

it("serves the generated catalog through the Worker OAuth provider in both protocol versions", async () => {
  const workerEnv = { ...env, OAUTH_KV: (bindings as unknown as Env).OAUTH_KV } as Env;
  const resource = `${publicOrigin}/mcp`;
  const redirectUri = "http://127.0.0.1:43917/callback";
  const scope = ["catalog:read"];
  const oauth = getOAuthApi<Env>(
    {
      apiRoute: "/mcp",
      apiHandler: releaseWorker.apiHandler,
      defaultHandler: releaseWorker,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      scopesSupported: scope,
      resourceMetadata: { resource, authorization_servers: [publicOrigin] },
    },
    workerEnv
  );
  const client = await oauth.createClient({
    redirectUris: [redirectUri],
    tokenEndpointAuthMethod: "none",
  });
  const verifier = "local-workerd-test-pkce-verifier-000000000000";
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const grant = await oauth.completeAuthorization({
    request: {
      responseType: "code",
      clientId: client.clientId,
      redirectUri,
      scope,
      resource,
      state: "local-test",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    },
    userId: "1",
    metadata: {},
    scope,
    props: { githubUserId: "1", resource, scopes: scope },
  });
  const tokenResponse = await fetchWorker(
    releaseWorker,
    "/oauth/token",
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.clientId,
        code: new URL(grant.redirectTo).searchParams.get("code")!,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource,
      }),
    },
    workerEnv
  );
  expect(tokenResponse.status).toBe(200);
  const { access_token } = await tokenResponse.json<{ access_token: string }>();
  expect(typeof access_token).toBe("string");

  for (const modern of [true, false]) {
    const version = modern ? "2026-07-28" : "2025-11-25";
    const clientInfo = { name: "local-worker-test", version: "1.0.0" };
    async function rpc(method: string, params: Record<string, unknown> = {}) {
      const response = await fetchWorker(
        releaseWorker,
        "/mcp",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${access_token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": version,
            ...(modern && { "mcp-method": method }),
            ...(modern && typeof params.name === "string" && { "mcp-name": params.name }),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params: modern
              ? {
                  ...params,
                  _meta: {
                    "io.modelcontextprotocol/clientInfo": clientInfo,
                    "io.modelcontextprotocol/clientCapabilities": {},
                    "io.modelcontextprotocol/protocolVersion": version,
                  },
                }
              : params,
          }),
        },
        workerEnv
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const raw = await response.text();
      const data = response.headers.get("content-type")?.includes("text/event-stream")
        ? raw
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6)
        : raw;
      return JSON.parse(data!) as unknown;
    }
    const discovery = modern
      ? await rpc("server/discover")
      : await rpc("initialize", { protocolVersion: version, clientInfo, capabilities: {} });
    expect(discovery).toMatchObject({
      result: {
        capabilities: { extensions: { "io.modelcontextprotocol/skills": expect.any(Object) } },
      },
    });
    if (modern) {
      expect(await rpc("skills/list")).toMatchObject({ result: { skills: expect.any(Array) } });
    }
    const retrieved = await rpc("tools/call", {
      name: "get_skill_file",
      arguments: { name: "fixture-unicode-notes", path: "assets/数据.txt" },
    });
    expect(retrieved).toMatchObject({
      result: { content: [{ type: "text", text: expect.stringContaining("sha256:") }] },
    });
  }
});
