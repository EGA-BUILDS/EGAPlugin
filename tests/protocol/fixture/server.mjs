// Test-only SEP-2640 / MCP reference server.
//
// Purpose: give the acceptance suite (scripts/acceptance/mcp-suite.mjs) and the
// installed MCP clients a real, local target without deploying anything. It uses
// the exact SDK versions pinned by the V1-001 feasibility report and implements
// the V1 contract shape: modern + legacy protocol eras, skills extension, and the
// three fallback tools over one immutable in-memory bundle.
//
// This file is a fixture. It is not the product implementation and must never be
// deployed to Cloudflare or included in the Worker bundle.

import http from "node:http";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { SkillsExtension } from "@modelcontextprotocol/server/ext/skills";
import { z } from "zod";
import { expectedCatalog, frontmatter, readApprovedFile } from "./corpus.mjs";

const SERVICE_INFO = { name: "ega-plugin-acceptance-fixture", version: "0.0.0" };
const SKILLS = expectedCatalog();
const SKILLS_BY_NAME = new Map(SKILLS.map((skill) => [skill.name, skill]));

const skillEntries = SKILLS.map((skill) => ({
  uri: skill.uri,
  frontmatter: frontmatter(skill.name),
  resources: skill.files.map((file) => ({
    uri: file.uri,
    digest: file.digest,
    size: file.size,
  })),
}));

const entriesByUri = new Map(skillEntries.map((entry) => [entry.uri, entry]));

const extension = new SkillsExtension({
  source: {
    list: async () => ({ skills: skillEntries }),
    get: async (uri) => entriesByUri.get(uri),
    read: async (uri) => {
      const match = /^skill:\/\/([^/]+)\/(.+)$/.exec(uri);
      if (!match) return undefined;
      const bytes = readApprovedFile(decodeURIComponent(match[1]), decodeURIComponent(match[2]));
      return bytes ? { bytes } : undefined;
    },
  },
});

const jsonText = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

const errorText = (message) => ({
  content: [{ type: "text", text: JSON.stringify({ error: message }) }],
  isError: true,
});

function isSafeRelativePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 256) return false;
  if (path.includes("\\") || path.includes("\0")) return false;
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function registerFallbackTools(server) {
  server.registerTool(
    "search_skills",
    {
      title: "Search skills",
      description: "Lexically filter the approved skill catalog by name or description.",
      inputSchema: z.object({
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    },
    async ({ query = "", limit = 20 }) => {
      const needle = query.trim().toLowerCase();
      const matches = SKILLS.filter((skill) => {
        if (!needle) return true;
        const fm = frontmatter(skill.name);
        return `${skill.name} ${fm.description ?? ""}`.toLowerCase().includes(needle);
      })
        .slice(0, limit)
        .map((skill) => ({
          name: skill.name,
          description: frontmatter(skill.name).description,
          uri: skill.uri,
        }));
      return jsonText({ skills: matches, query, total: matches.length });
    }
  );

  server.registerTool(
    "get_skill",
    {
      title: "Get skill",
      description: "Return SKILL.md instructions and the approved file manifest for one skill.",
      inputSchema: z.object({ name: z.string().min(1).max(64) }),
    },
    async ({ name }) => {
      const skill = SKILLS_BY_NAME.get(name);
      if (!skill) return errorText("skill_not_found");
      const skillMd = skill.files.find((file) => file.path === "SKILL.md");
      if (!skillMd) return errorText("skill_missing_instructions");
      const text = new TextDecoder().decode(readApprovedFile(name, "SKILL.md"));
      return jsonText({
        name,
        uri: skill.uri,
        instructions: text,
        frontmatter: frontmatter(name),
        files: skill.files.map((file) => ({
          path: file.path,
          uri: file.uri,
          size: file.size,
          digest: file.digest,
        })),
      });
    }
  );

  server.registerTool(
    "get_skill_file",
    {
      title: "Get skill file",
      description: "Return one exact approved supporting file from a skill.",
      inputSchema: z.object({
        name: z.string().min(1).max(64),
        path: z.string().min(1).max(256),
      }),
    },
    async ({ name, path }) => {
      if (!isSafeRelativePath(path)) return errorText("invalid_path");
      const skill = SKILLS_BY_NAME.get(name);
      if (!skill) return errorText("skill_not_found");
      const file = skill.files.find((candidate) => candidate.path === path);
      if (!file) return errorText("file_not_found");
      const text = new TextDecoder().decode(readApprovedFile(name, path));
      return jsonText({
        name,
        path,
        uri: file.uri,
        size: file.size,
        digest: file.digest,
        text,
      });
    }
  );
}

function buildHandler() {
  return createMcpHandler(
    () => {
      const server = new McpServer(SERVICE_INFO);
      extension.attach(server);
      registerFallbackTools(server);
      return server;
    },
    { responseMode: "json" }
  );
}

const handler = buildHandler();

const NO_STORE = "private, no-store";

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": NO_STORE,
      ...headers,
    },
  });
}

/**
 * The fixture emits one complete `skills/list` page and never issues cursors.
 * Any supplied cursor is therefore stale or malformed and must be rejected as
 * invalid params instead of being silently ignored.
 */
async function invalidCursorRequestId(request) {
  if (request.method !== "POST") return undefined;
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return undefined;
  let payload;
  try {
    payload = JSON.parse(await request.clone().text());
  } catch {
    return undefined;
  }
  for (const message of Array.isArray(payload) ? payload : [payload]) {
    if (message?.method !== "skills/list") continue;
    if (!("cursor" in (message.params ?? {}))) continue;
    return message.id ?? null;
  }
  return undefined;
}

function createApp({ token, issuer, allowedOrigins }) {
  const authEnabled = Boolean(token);
  const metadataUrl = `${issuer}/.well-known/oauth-protected-resource/mcp`;

  return async function app(request) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json(200, {
        status: "ok",
        service: SERVICE_INFO.name,
        mode: authEnabled ? "auth" : "open",
      });
    }

    if (url.pathname === "/mcp") {
      // Streamable HTTP Origin validation runs before auth and before SDK
      // dispatch. Requests without Origin remain subject to auth.
      const origin = request.headers.get("origin");
      if (origin !== null) {
        let parsed;
        try {
          parsed = new URL(origin);
        } catch {
          return json(403, { error: "invalid_origin" });
        }
        const originForm =
          (parsed.protocol === "http:" || parsed.protocol === "https:") &&
          parsed.pathname === "/" &&
          !parsed.search &&
          !parsed.hash &&
          !parsed.username &&
          !parsed.password;
        if (!originForm || !allowedOrigins.includes(parsed.origin)) {
          return json(403, { error: "origin_not_allowed" });
        }
      }
    }

    if (authEnabled) {
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return json(200, {
          resource: `${issuer}/mcp`,
          authorization_servers: [issuer],
          scopes_supported: ["catalog:read"],
          bearer_methods_supported: ["header"],
        });
      }
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        return json(404, { error: "not_found" });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return json(200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["catalog:read"],
        });
      }
    }

    if (url.pathname !== "/mcp") {
      return json(404, { error: "not_found" });
    }

    if (authEnabled) {
      const authorization = request.headers.get("authorization") ?? "";
      if (authorization !== `Bearer ${token}`) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32001, message: "unauthorized" },
          }),
          {
            status: 401,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": NO_STORE,
              "www-authenticate": `Bearer resource_metadata="${metadataUrl}", scope="catalog:read"`,
            },
          }
        );
      }
    }

    const id = await invalidCursorRequestId(request);
    if (id !== undefined) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Invalid cursor" },
        }),
        {
          status: 400,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": NO_STORE,
          },
        }
      );
    }

    return handler.fetch(request);
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const readFlag = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const port = Number(readFlag("--port", process.env.PORT ?? "0"));
  const host = readFlag("--host", "127.0.0.1");
  const token = readFlag("--auth-token", process.env.ACCEPTANCE_TOKEN ?? "");
  const publicUrl = readFlag("--public-url", "");
  const logRequests = args.includes("--log-requests");
  const allowedOrigins = args.reduce((accumulator, argument, index) => {
    if (argument === "--allowed-origin" && args[index + 1]) accumulator.push(args[index + 1]);
    return accumulator;
  }, []);
  if (process.env.ALLOWED_ORIGIN) allowedOrigins.push(...process.env.ALLOWED_ORIGIN.split(","));

  const server = http.createServer(async (req, res) => {
    const hostHeader = req.headers.host ?? `${host}:${port}`;
    const issuer = publicUrl || `http://${hostHeader}`;
    const app = createApp({ token, issuer, allowedOrigins });
    try {
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      if (logRequests) {
        let method = "(none)";
        try {
          method = body?.length
            ? (JSON.parse(body.toString("utf8"))?.method ?? "(none)")
            : "(none)";
        } catch {
          method = "(unparsed)";
        }
        const era = req.headers["mcp-protocol-version"] ?? "legacy";
        console.log(`[req] ${req.method} ${req.url} era=${era} rpc=${method}`);
      }
      const request = new Request(`${issuer}${req.url}`, {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([key, value]) =>
          value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]]
        ),
        body,
      });
      const response = await app(request);
      const bytes = Buffer.from(await response.arrayBuffer());
      const headers = Object.fromEntries(response.headers.entries());
      if (req.url?.split("?")[0] === "/mcp") headers["cache-control"] = NO_STORE;
      res.writeHead(response.status, headers);
      res.end(bytes);
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json", "cache-control": NO_STORE });
      res.end(JSON.stringify({ error: "fixture_internal_error" }));
      console.error("[fixture] request failed:", error?.name ?? "Error");
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const base = publicUrl || `http://${host}:${address.port}`;
  console.log(
    `LISTENING ${base} mode=${token ? "auth" : "open"} skills=${SKILLS.length} files=${SKILLS.reduce((n, s) => n + s.files.length, 0)}`
  );
  console.log(
    `EXPOSED ${JSON.stringify(SKILLS.map((skill) => ({ name: skill.name, files: skill.files.map((f) => f.path) })))}`
  );

  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[fixture] fatal:", error?.message ?? error);
  process.exit(1);
});
