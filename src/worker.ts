import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  authorizationErrorRedirect,
  insufficientScope,
  type OAuthHelpers,
  type OAuthResourceAuth,
} from "@cloudflare/workers-oauth-provider";
import { originValidationResponse } from "@modelcontextprotocol/server";
import { authzFailure } from "./authz";
import { createMcpRuntime, type McpRuntimeOptions } from "./mcp";
import type { RuntimeCatalog } from "./catalog";

export const DEFAULT_REQUIRED_SCOPE = "catalog:read";
const MCP_PATH = "/mcp";
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_USER_AGENT = "ega-plugin";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Absolute public origin, for example `https://ega-plugin.example.workers.dev`. */
  PUBLIC_ORIGIN?: string;
  /** Canonical protected resource URL; takes precedence over `PUBLIC_ORIGIN`. */
  MCP_RESOURCE?: string;
  /** Read scope required on every protected MCP call. Defaults to `catalog:read`. */
  REQUIRED_SCOPE?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** Numeric GitHub user ID of the only authorized owner. */
  GITHUB_OWNER_ID: string;
  /** Comma-separated additional browser origins or hostnames. */
  ALLOWED_ORIGINS?: string;
}

export interface FetchHandler {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
}

export interface EgaWorker extends FetchHandler {
  /** The protected handler that `OAuthProvider` dispatches to for `/mcp`. */
  apiHandler: FetchHandler;
}

export type WorkerOptions = McpRuntimeOptions;

interface ResolvedConfig {
  origin: string;
  resource: string;
  callbackUrl: string;
  ownerId: string;
  requiredScope: string;
  clientId: string | undefined;
  clientSecret: string | undefined;
  allowedOriginHostnames: string[];
}

const noStore = (response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const textResponse = (status: number, text: string): Response =>
  noStore(
    new Response(text, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  );

const forbidden = (): Response => textResponse(403, "Forbidden");

const serviceUnavailable = (): Response => textResponse(503, "Service unavailable");

const unauthorized = (config: ResolvedConfig): Response => {
  const metadataUrl = `${config.origin}/.well-known/oauth-protected-resource${MCP_PATH}`;
  return noStore(
    new Response("Unauthorized", {
      status: 401,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
      },
    })
  );
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

function consentPage(
  details: {
    clientName: string;
    clientDomain?: string | null;
    redirectHost: string;
    redirectIsLoopback: boolean;
    scope: string[];
  },
  handle: string,
  requiredScope: string
): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const scopes = details.scope
    .filter((scope) => scope === requiredScope)
    .map(
      (scope) =>
        `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ` +
        `${escapeHtml(scope)}</label>`
    )
    .join("<br>");
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Authorize ${name}</title>
<body>
<h1>Allow ${name} to access this server?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer. Continue only if you just started signing in from it.</strong></p>" : ""}
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  ${scopes}
  <p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p>
</form>
</body>
</html>`;
}

function handleAuthorizationError(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) {
    return Response.redirect(error.redirectTo, 302);
  }
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    const message =
      error instanceof AuthorizationError ? error.description : "This app could not be verified.";
    return textResponse(400, message);
  }
  throw error;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function parseAbsoluteOrigin(value: string | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    return null;
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  return url.origin;
}

function parseResource(resource: string | undefined): { origin: string; resource: string } | null {
  if (typeof resource !== "string" || resource.length === 0) return null;
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    return null;
  }
  if (url.pathname !== MCP_PATH || url.search !== "" || url.hash !== "") return null;
  return { origin: url.origin, resource: `${url.origin}${MCP_PATH}` };
}

function allowedOriginHostnames(origin: string, configured: string | undefined): string[] {
  const allowed = new Set<string>([new URL(origin).hostname]);
  for (const entry of (configured ?? "").split(",")) {
    const value = entry.trim();
    if (value.length === 0) continue;
    let hostname = value.toLowerCase();
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
      hostname = parsed.hostname;
    } catch {
      // A bare hostname is accepted; scheme, port and wildcard forms are not.
    }
    if (hostname.length === 0 || hostname === "*" || hostname.includes("/")) continue;
    if (hostname.includes(":") && !hostname.startsWith("[")) continue;
    allowed.add(hostname);
  }
  return [...allowed];
}

function resolveConfig(env: Env): ResolvedConfig | null {
  if (!env || typeof env !== "object") return null;

  const hasResource = typeof env.MCP_RESOURCE === "string" && env.MCP_RESOURCE.length > 0;
  const fromResource = hasResource ? parseResource(env.MCP_RESOURCE) : null;
  if (hasResource && fromResource === null) return null;
  const origin = fromResource?.origin ?? parseAbsoluteOrigin(env.PUBLIC_ORIGIN);
  if (origin === null) return null;

  const ownerId = typeof env.GITHUB_OWNER_ID === "string" ? env.GITHUB_OWNER_ID.trim() : "";
  if (!/^\d+$/.test(ownerId)) return null;
  if (!env.OAUTH_KV || typeof env.OAUTH_KV !== "object") return null;

  const requiredScope =
    typeof env.REQUIRED_SCOPE === "string" && env.REQUIRED_SCOPE.length > 0
      ? env.REQUIRED_SCOPE
      : DEFAULT_REQUIRED_SCOPE;

  return {
    origin,
    resource: `${origin}${MCP_PATH}`,
    callbackUrl: `${origin}/oauth/callback`,
    ownerId,
    requiredScope,
    clientId:
      typeof env.GITHUB_CLIENT_ID === "string" && env.GITHUB_CLIENT_ID.length > 0
        ? env.GITHUB_CLIENT_ID
        : undefined,
    clientSecret:
      typeof env.GITHUB_CLIENT_SECRET === "string" && env.GITHUB_CLIENT_SECRET.length > 0
        ? env.GITHUB_CLIENT_SECRET
        : undefined,
    allowedOriginHostnames: allowedOriginHostnames(origin, env.ALLOWED_ORIGINS),
  };
}

async function exchangeGithubCode(
  config: ResolvedConfig & { clientId: string; clientSecret: string },
  code: string
): Promise<string | null> {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": GITHUB_USER_AGENT,
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.callbackUrl,
    }),
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { access_token?: unknown };
  return typeof payload.access_token === "string" ? payload.access_token : null;
}

async function fetchGithubUser(accessToken: string): Promise<{ id: number; login: string } | null> {
  const response = await fetch(GITHUB_USER_URL, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": GITHUB_USER_AGENT,
    },
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { id?: unknown; login?: unknown };
  return typeof payload.id === "number" && typeof payload.login === "string"
    ? { id: payload.id, login: payload.login }
    : null;
}

function createDefaultHandler(config: ResolvedConfig): ExportedHandler<Env> {
  return {
    async fetch(request, env): Promise<Response> {
      const url = new URL(request.url);
      const oauth = env.OAUTH_PROVIDER;

      if (url.pathname === "/authorize") {
        try {
          if (config.clientId === undefined) return serviceUnavailable();

          if (request.method === "GET") {
            const authRequest = await oauth.parseAuthRequest(request);
            const details = await oauth.describeConsent(authRequest);
            const consent = await oauth.beginConsent(authRequest);
            consent.headers.set("content-type", "text/html; charset=utf-8");
            return new Response(consentPage(details, consent.handle, config.requiredScope), {
              headers: consent.headers,
            });
          }

          if (request.method === "POST") {
            const form = await request.formData();
            const handle = String(form.get("handle") ?? "");
            if (form.get("decision") !== "approve") {
              const denied = await oauth.denyConsent(request, handle);
              return new Response(null, { status: 302, headers: denied.headers });
            }

            const requestedScopes = form
              .getAll("scope")
              .map(String)
              .filter((scope) => scope === config.requiredScope);
            const approved = await oauth.approveConsent(
              request,
              handle,
              requestedScopes.length > 0 ? { scope: requestedScopes } : undefined
            );
            const upstream = await oauth.beginUpstream(approved.request, {
              data: {},
              headers: approved.headers,
            });
            const target = new URL(GITHUB_AUTHORIZE_URL);
            target.searchParams.set("client_id", config.clientId);
            target.searchParams.set("redirect_uri", config.callbackUrl);
            target.searchParams.set("scope", "read:user");
            target.searchParams.set("state", upstream.state);
            upstream.headers.set("Location", target.toString());
            return new Response(null, { status: 302, headers: upstream.headers });
          }

          return textResponse(405, "Method not allowed");
        } catch (error) {
          return handleAuthorizationError(error);
        }
      }

      if (url.pathname === "/oauth/callback") {
        try {
          if (config.clientId === undefined || config.clientSecret === undefined) {
            return serviceUnavailable();
          }
          const resumed = await oauth.finishUpstream(request);
          if (url.searchParams.has("error")) {
            resumed.headers.set(
              "Location",
              authorizationErrorRedirect(resumed.request, "access_denied")
            );
            return new Response(null, { status: 302, headers: resumed.headers });
          }

          const code = url.searchParams.get("code");
          if (!code) return textResponse(400, "Missing authorization code.");

          const accessToken = await exchangeGithubCode(
            { ...config, clientId: config.clientId, clientSecret: config.clientSecret },
            code
          );
          if (!accessToken) {
            resumed.headers.set(
              "Location",
              authorizationErrorRedirect(resumed.request, "access_denied")
            );
            return new Response(null, { status: 302, headers: resumed.headers });
          }

          const user = await fetchGithubUser(accessToken);
          if (!user || String(user.id) !== config.ownerId) {
            return textResponse(403, "This GitHub account is not the authorized owner.");
          }

          const completed = await oauth.completeAuthorization({
            request: resumed.request,
            userId: String(user.id),
            metadata: {},
            scope: resumed.request.scope,
            props: { githubUserId: user.id, githubLogin: user.login },
          });
          resumed.headers.set("Location", completed.redirectTo);
          return new Response(null, { status: 302, headers: resumed.headers });
        } catch (error) {
          return handleAuthorizationError(error);
        }
      }

      return textResponse(404, "Not found");
    },
  };
}

function authorizationFailureResponse(
  failure: ReturnType<typeof authzFailure>,
  auth: OAuthResourceAuth | undefined,
  config: ResolvedConfig
): Response | null {
  if (failure === null) return null;
  if (failure === "scope") {
    return auth ? insufficientScope(auth, [config.requiredScope]) : unauthorized(config);
  }
  if (failure === "owner" && auth === undefined) return unauthorized(config);
  return forbidden();
}

/**
 * The authorization seam for `/mcp`. It performs the application-specific
 * checks that the OAuth provider advertises but does not enforce: owner
 * subject, required scope, token resource binding, expiry and Origin. It is
 * exported so the path can be exercised without a bypass flag.
 */
export function createApiHandler(mcpRuntime: ReturnType<typeof createMcpRuntime>): FetchHandler {
  return {
    async fetch(request, env, ctx): Promise<Response> {
      const config = resolveConfig(env);
      if (config === null) return serviceUnavailable();

      const rejected = originValidationResponse(request, config.allowedOriginHostnames);
      if (rejected) return noStore(rejected);

      const oauthContext = ctx as unknown as {
        props?: { githubUserId?: unknown; resource?: unknown; scopes?: unknown };
        auth?: OAuthResourceAuth;
      };

      let failure = authzFailure(
        oauthContext,
        config.ownerId,
        config.resource,
        config.requiredScope
      );

      if (failure === null && typeof oauthContext.props?.resource === "string") {
        if (oauthContext.props.resource !== config.resource) failure = "audience";
      }
      if (failure === null && Array.isArray(oauthContext.props?.scopes)) {
        const propsScopes = oauthContext.props.scopes.filter(
          (scope): scope is string => typeof scope === "string"
        );
        if (!propsScopes.includes(config.requiredScope)) failure = "scope";
      }

      const rejection = authorizationFailureResponse(failure, oauthContext.auth, config);
      if (rejection) return noStore(rejection);

      return noStore(await mcpRuntime.fetch(request));
    },
  };
}

function buildProvider(config: ResolvedConfig, apiHandler: FetchHandler): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    apiRoute: MCP_PATH,
    apiHandler,
    defaultHandler: createDefaultHandler(config),
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: [config.requiredScope],
    resourceMetadata: {
      resource: config.resource,
      authorization_servers: [config.origin],
    },
    requiredScopes: [config.requiredScope],
    clientIdMetadataDocumentEnabled: true,
  });
}

/**
 * Creates the Worker. Fails closed with `503` when the protected-resource
 * configuration is missing or invalid, before OAuth or MCP dispatch. GitHub
 * client credentials are only needed to start a new authorization; existing
 * grants remain enforceable without them.
 */
export function createWorker(catalog: RuntimeCatalog, options: WorkerOptions = {}): EgaWorker {
  const mcpRuntime = createMcpRuntime(catalog, options);
  const apiHandler = createApiHandler(mcpRuntime);
  const providers = new Map<string, OAuthProvider<Env>>();

  return {
    apiHandler,
    async fetch(request, env, ctx): Promise<Response> {
      const config = resolveConfig(env);
      if (config === null) return serviceUnavailable();

      const url = new URL(request.url);
      if (url.pathname === MCP_PATH) {
        const rejected = originValidationResponse(request, config.allowedOriginHostnames);
        if (rejected) return noStore(rejected);
      }

      const key = `${config.origin}|${config.ownerId}|${config.requiredScope}`;
      let provider = providers.get(key);
      if (provider === undefined) {
        provider = buildProvider(config, apiHandler);
        providers.set(key, provider);
      }

      return noStore(await provider.fetch(request, env, ctx));
    },
  };
}
