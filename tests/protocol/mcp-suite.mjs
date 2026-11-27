#!/usr/bin/env node
// Dependency-free MCP wire-level acceptance suite for EGAPlugin.
//
// Covers both protocol eras an EGAPlugin server must serve:
//   modern  — 2026-07-28: server/discover + skills/list|get + required _meta envelope
//   legacy  — 2025-11-25 and older: initialize handshake + tools/resources
//
// It talks raw JSON-RPC over Streamable HTTP so SDK conveniences cannot hide
// header, era, envelope, digest, pagination, or auth defects. It reads only the
// endpoint you give it, never writes, and prints no credentials.
//
// Usage:
//   node scripts/acceptance/mcp-suite.mjs --url http://127.0.0.1:8787/mcp
//   node scripts/acceptance/mcp-suite.mjs --url https://host/mcp --token-env MCP_TOKEN
//   node scripts/acceptance/mcp-suite.mjs --url ... --require-auth --json-out report.json
//
// Exit: 0 all required checks pass; 1 any failure; 2 required coverage skipped.

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import process from "node:process";

const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-11-25";
const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
const FALLBACK_TOOLS = ["get_skill", "get_skill_file", "search_skills"];

// ---------------------------------------------------------------- CLI parsing

function parseArgs(argv) {
  const options = {
    url: "",
    token: "",
    tokenEnv: "",
    requireAuth: false,
    modernOnly: false,
    legacyOnly: false,
    timeoutMs: 15000,
    jsonOut: "",
    allowedOrigin: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[index];
    };
    switch (arg) {
      case "--url":
        options.url = next();
        break;
      case "--token":
        options.token = next();
        break;
      case "--token-env":
        options.tokenEnv = next();
        break;
      case "--require-auth":
        options.requireAuth = true;
        break;
      case "--modern-only":
        options.modernOnly = true;
        break;
      case "--legacy-only":
        options.legacyOnly = true;
        break;
      case "--timeout":
        options.timeoutMs = Number(next()) * 1000;
        break;
      case "--json-out":
        options.jsonOut = next();
        break;
      case "--allowed-origin":
        options.allowedOrigin = next();
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.tokenEnv) options.token = process.env[options.tokenEnv] ?? "";
  if (!options.url) throw new Error("--url is required");
  if (options.modernOnly && options.legacyOnly)
    throw new Error("choose modern or legacy, not both");
  return options;
}

function printHelp() {
  console.log(`EGAPlugin MCP acceptance suite

  --url <url>            MCP endpoint, e.g. https://host/mcp (required)
  --token <token>        Bearer token (prefer --token-env)
  --token-env <name>     Read bearer token from this environment variable
  --require-auth         Treat auth/security coverage as required
  --modern-only          Skip legacy-era checks
  --legacy-only          Skip modern-era checks
  --timeout <seconds>    Per-request timeout (default 15)
  --json-out <path>      Write the full machine-readable report
  --allowed-origin <o>   Origin expected to be accepted (for ORIGIN checks)

Environment is read, never written. Tokens are never printed or persisted.`);
}

// ------------------------------------------------------------------ reporting

const results = [];
let currentArea = "setup";

function area(name) {
  currentArea = name;
}

async function check(id, title, options, body) {
  const { optional = false, era = "" } = options ?? {};
  const started = Date.now();
  try {
    const detail = await body();
    results.push({
      id,
      area: currentArea,
      era,
      title,
      status: "pass",
      optional,
      ms: Date.now() - started,
      detail: detail ?? "",
    });
    log(`  PASS  ${id}  ${title}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    const status = error?.skip ? "skip" : "fail";
    results.push({
      id,
      area: currentArea,
      era,
      title,
      status,
      optional,
      ms: Date.now() - started,
      detail: error?.message ?? String(error),
      evidence: error?.evidence,
    });
    log(`  ${status === "skip" ? "SKIP" : "FAIL"}  ${id}  ${title} — ${error?.message ?? error}`);
    if (status === "fail" && error?.evidence !== undefined) {
      log(`        evidence: ${truncate(JSON.stringify(error.evidence), 800)}`);
    }
  }
}

const skip = (message) => Object.assign(new Error(message), { skip: true });
const fail = (message, evidence) => Object.assign(new Error(message), { evidence });

function log(line) {
  console.log(line);
}

function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function assert(condition, message, evidence) {
  if (!condition) throw fail(message, evidence);
}

// ------------------------------------------------------------- JSON-RPC client

function parseSse(text) {
  const messages = [];
  for (const block of text.split(/\n\n/)) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (data) {
      try {
        messages.push(JSON.parse(data));
      } catch {
        /* ignore non-JSON keepalive */
      }
    }
  }
  return messages;
}

class McpClient {
  constructor({ url, token, timeoutMs }) {
    this.url = url;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
  }

  async rpc(method, params, { modern, extraHeaders = {}, withMeta = true } = {}) {
    const id = this.nextId++;
    const body = {
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...(params ?? {}),
        ...(modern && withMeta
          ? {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
                "io.modelcontextprotocol/clientInfo": { name: "ega-acceptance", version: "1.0.0" },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            }
          : {}),
      },
    };
    // 2026-07-28 requires Mcp-Name to echo the addressed item: tool name for
    // tools/call, resource URI for resources/read and skills/get.
    const mcpName =
      typeof params?.uri === "string"
        ? params.uri
        : typeof params?.name === "string"
          ? params.name
          : undefined;
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...(modern
        ? {
            "mcp-protocol-version": MODERN_VERSION,
            "mcp-method": method,
            ...(mcpName ? { "mcp-name": mcpName } : {}),
          }
        : {}),
      ...extraHeaders,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (error) {
      throw fail(`transport error for ${method}: ${error?.name ?? "Error"}`, { method });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    const messages = contentType.includes("text/event-stream") ? parseSse(text) : safeJson(text);
    const message = Array.isArray(messages)
      ? ([...messages].reverse().find((entry) => entry && entry.id === id) ?? messages.at(-1))
      : messages;

    return {
      status: response.status,
      headers: response.headers,
      raw: text,
      message,
      isSse: contentType.includes("text/event-stream"),
    };
  }

  async request(method, params, options) {
    const result = await this.rpc(method, params, options);
    if (result.status === 401 || result.status === 403) {
      throw fail(`${method} was denied with HTTP ${result.status}`, {
        status: result.status,
        body: truncate(result.raw, 400),
      });
    }
    if (result.status >= 400) {
      throw fail(`${method} returned HTTP ${result.status}`, {
        status: result.status,
        body: truncate(result.raw, 400),
      });
    }
    if (result.message?.error) {
      throw fail(
        `${method} returned JSON-RPC error ${result.message.error.code}`,
        result.message.error
      );
    }
    if (!result.message || !("result" in result.message)) {
      throw fail(`${method} returned no JSON-RPC result`, { body: truncate(result.raw, 400) });
    }
    return result;
  }

  async expectError(method, params, options, label) {
    const result = await this.rpc(method, params, options);
    const denied = result.status === 401 || result.status === 403 || result.status === 400;
    if (!denied && !result.message?.error) {
      throw fail(`${label}: server accepted an invalid request`, {
        status: result.status,
        body: truncate(result.raw, 400),
      });
    }
    return `${result.status} ${result.message?.error?.code ?? "http"}`;
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeContent(content) {
  assert(content, "missing resource content");
  if (typeof content.text === "string") return Buffer.from(content.text, "utf8");
  assert(typeof content.blob === "string", "resource content has neither text nor blob");
  return Buffer.from(content.blob, "base64");
}

function skillNameFromUri(uri) {
  const match = /^skill:\/\/([^/]+)\/SKILL\.md$/.exec(uri ?? "");
  return match ? decodeURIComponent(match[1]) : undefined;
}

/** Compare URIs after percent-decoding; servers may legally encode path bytes. */
function sameUri(left, right) {
  if (left === right) return true;
  const decode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  return decode(left) === decode(right);
}

function pathFromUri(uri, skillName) {
  const prefix = `skill://${encodeURIComponent(skillName)}/`;
  if (typeof uri !== "string") return undefined;
  if (uri.startsWith(prefix)) return decodeURIComponent(uri.slice(prefix.length));
  const rawPrefix = `skill://${skillName}/`;
  return uri.startsWith(rawPrefix) ? uri.slice(rawPrefix.length) : undefined;
}

function normalizeSkill(entry) {
  return {
    uri: entry.uri,
    name: entry.frontmatter?.name,
    description: entry.frontmatter?.description,
    frontmatter: entry.frontmatter,
    resources: Array.isArray(entry.resources) ? entry.resources : [],
  };
}

async function listAllSkills(client, { modern }) {
  const skills = [];
  const seenCursors = new Set();
  let cursor;
  let page = 0;
  let response;
  do {
    page += 1;
    response = await client.request("skills/list", cursor ? { cursor } : {}, { modern });
    const result = response.message.result;
    assert(Array.isArray(result.skills), "skills/list result.skills is not an array", result);
    skills.push(...result.skills.map(normalizeSkill));
    const next = result.nextCursor;
    if (next) {
      assert(!seenCursors.has(next), `skills/list repeated cursor ${next}`);
      seenCursors.add(next);
      cursor = next;
    } else {
      cursor = undefined;
    }
    assert(page <= 200, "skills/list exceeded 200 pages");
  } while (cursor);
  return { skills, pageCount: page, lastResult: response.message.result };
}

// ---------------------------------------------------------------------- checks

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const client = new McpClient({
    url: options.url,
    token: options.token,
    timeoutMs: options.timeoutMs,
  });
  const report = {
    tool: "ega-plugin-mcp-acceptance",
    version: "1.0.0",
    startedAt: new Date().toISOString(),
    target: options.url,
    authMode: options.token ? "bearer" : "none",
    requiredAuth: options.requireAuth,
    modernVersion: MODERN_VERSION,
    legacyVersion: LEGACY_VERSION,
    results,
  };

  console.log(`EGAPlugin MCP acceptance`);
  console.log(`target: ${options.url}`);
  console.log(`auth: ${options.token ? "bearer provided" : "none provided"}`);
  console.log("");

  const state = { catalog: [], modern: !options.legacyOnly, legacy: !options.modernOnly };

  // ------------------------------------------------------------ auth / handshake

  if (state.modern) {
    area("modern");
    await runModern(client, state, options);
  }

  if (state.legacy) {
    area("legacy");
    await runLegacy(client, state, options);
  }

  area("cross-era");
  await runCrossEra(client, state, options);

  area("origin");
  await runOrigin(client, state, options);

  area("robustness");
  await runRobustness(client, state, options);

  if (options.requireAuth || options.token) {
    area("auth");
    await runAuth(client, options);
  } else {
    area("auth");
    await check(
      "AUTH-01",
      "unauthenticated challenge and metadata",
      { optional: true },
      async () => {
        throw skip("no token supplied and --require-auth not set");
      }
    );
  }

  // ------------------------------------------------------------------- summary

  const counts = results.reduce(
    (accumulator, entry) => {
      accumulator[entry.status] = (accumulator[entry.status] ?? 0) + 1;
      return accumulator;
    },
    { pass: 0, fail: 0, skip: 0 }
  );
  const requiredSkips = results.filter((entry) => entry.status === "skip" && !entry.optional);
  const failures = results.filter((entry) => entry.status === "fail");
  const exitCode = failures.length > 0 ? 1 : requiredSkips.length > 0 ? 2 : 0;

  report.finishedAt = new Date().toISOString();
  report.summary = {
    ...counts,
    requiredSkips: requiredSkips.length,
    failures: failures.map((entry) => entry.id),
    exitCode,
  };

  console.log("");
  console.log(`summary: ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip`);
  if (requiredSkips.length) {
    console.log(`required coverage skipped: ${requiredSkips.map((entry) => entry.id).join(", ")}`);
  }
  if (failures.length) {
    console.log(`failures: ${failures.map((entry) => entry.id).join(", ")}`);
  }
  console.log(
    exitCode === 0 ? "RESULT: PASS" : exitCode === 1 ? "RESULT: FAIL" : "RESULT: INCOMPLETE"
  );

  if (options.jsonOut) {
    await writeFile(options.jsonOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`report: ${options.jsonOut}`);
  }

  process.exit(exitCode);
}

async function runModern(client, state) {
  await check(
    "MOD-01",
    "server/discover advertises resources + skills extension",
    { era: "modern" },
    async () => {
      const { message } = await client.request("server/discover", {}, { modern: true });
      const capabilities = message.result?.capabilities ?? {};
      assert(capabilities.resources, "capabilities.resources missing", capabilities);
      assert(
        capabilities.extensions?.[SKILLS_EXTENSION],
        `capabilities.extensions["${SKILLS_EXTENSION}"] missing`,
        capabilities
      );
      return `versions=${JSON.stringify(message.result?.supportedVersions ?? [])}`;
    }
  );

  await check("MOD-02", "server/discover supports 2026-07-28", { era: "modern" }, async () => {
    const { message } = await client.request("server/discover", {}, { modern: true });
    const versions = message.result?.supportedVersions ?? [];
    assert(
      Array.isArray(versions) && versions.includes(MODERN_VERSION),
      `supportedVersions lacks ${MODERN_VERSION}`,
      versions
    );
    return versions.join(",");
  });

  await check(
    "MOD-03",
    "modern request without _meta envelope is rejected",
    { era: "modern" },
    async () => {
      const outcome = await client.expectError(
        "skills/list",
        {},
        { modern: true, withMeta: false },
        "missing _meta"
      );
      return outcome;
    }
  );

  await check(
    "MOD-04",
    "skills/list returns well-formed manifest with sha256 digests",
    { era: "modern" },
    async () => {
      const { skills, pageCount, lastResult } = await listAllSkills(client, { modern: true });
      assert(skills.length > 0, "catalog is empty");
      for (const skill of skills) {
        assert(skill.uri && skillNameFromUri(skill.uri), `invalid skill uri ${skill.uri}`);
        assert(
          skill.name === skillNameFromUri(skill.uri),
          `frontmatter name ${skill.name} != uri`,
          skill
        );
        assert(
          typeof skill.description === "string" && skill.description.length > 0,
          `missing description for ${skill.name}`
        );
        assert(skill.resources.length > 0, `no resources for ${skill.name}`);
        const uris = new Set();
        for (const resource of skill.resources) {
          assert(
            /^sha256:[0-9a-f]{64}$/.test(resource.digest ?? ""),
            `bad digest for ${resource.uri}`,
            resource
          );
          assert(
            Number.isInteger(resource.size) && resource.size >= 0,
            `bad size for ${resource.uri}`,
            resource
          );
          assert(!uris.has(resource.uri), `duplicate resource ${resource.uri}`);
          uris.add(resource.uri);
          assert(!resource.uri.includes("/."), `dotfile exposed: ${resource.uri}`);
        }
        assert(
          skill.resources.some((resource) => resource.uri === skill.uri),
          `SKILL.md missing from manifest for ${skill.name}`
        );
      }
      state.catalog = skills;
      state.listPageCount = pageCount;
      state.cacheHints = { ttlMs: lastResult.ttlMs, cacheScope: lastResult.cacheScope };
      return `${skills.length} skills, ${skills.reduce((n, s) => n + s.resources.length, 0)} files, ${pageCount} page(s)`;
    }
  );

  await check(
    "MOD-05",
    "pagination is stable and cursor-free listing matches",
    { era: "modern" },
    async () => {
      if (!state.catalog.length) throw skip("catalog discovery failed");
      assert(state.listPageCount >= 1, "no pages observed");
      const single = await client.request("skills/list", {}, { modern: true });
      const singleSkills = (single.message.result.skills ?? []).map(normalizeSkill);
      const byUri = new Map(state.catalog.map((skill) => [skill.uri, skill]));
      // A server may legitimately paginate the unpaginated request too; compare sets
      // only when it returned everything in one page.
      if (!single.message.result.nextCursor) {
        assert(
          singleSkills.length === state.catalog.length,
          "single-page count differs from paginated count"
        );
        for (const skill of singleSkills) {
          assert(byUri.has(skill.uri), `single-page listing introduced ${skill.uri}`);
          assert(
            JSON.stringify(skill.resources) === JSON.stringify(byUri.get(skill.uri).resources),
            `manifest drift between pages for ${skill.uri}`
          );
        }
        return `${singleSkills.length} skills identical`;
      }
      return `server always paginates (${state.listPageCount} pages for full catalog)`;
    }
  );

  await check(
    "MOD-06",
    "skills/get matches the listing without prior page state",
    { era: "modern" },
    async () => {
      if (!state.catalog.length) throw skip("catalog discovery failed");
      for (const skill of state.catalog) {
        const { message } = await client.request(
          "skills/get",
          { uri: skill.uri },
          { modern: true }
        );
        const got = normalizeSkill(message.result.skill ?? {});
        assert(got.uri === skill.uri, `skills/get uri mismatch for ${skill.uri}`, got);
        assert(got.name === skill.name, `skills/get name mismatch for ${skill.uri}`, got);
        assert(
          JSON.stringify(got.resources) === JSON.stringify(skill.resources),
          `skills/get manifest differs from skills/list for ${skill.uri}`,
          { listed: skill.resources, got: got.resources }
        );
      }
      return `${state.catalog.length} skills`;
    }
  );

  await check(
    "MOD-07",
    "resources/read returns exact bytes, size and sha256",
    { era: "modern" },
    async () => {
      if (!state.catalog.length) throw skip("catalog discovery failed");
      let files = 0;
      for (const skill of state.catalog) {
        for (const resource of skill.resources) {
          const { message } = await client.request(
            "resources/read",
            { uri: resource.uri },
            { modern: true }
          );
          const content = message.result?.contents?.[0];
          assert(
            content?.uri && sameUri(content.uri, resource.uri),
            `content uri mismatch for ${resource.uri}`,
            content
          );
          const bytes = decodeContent(content);
          assert(
            bytes.byteLength === resource.size,
            `byte length mismatch for ${resource.uri} (${bytes.byteLength} != ${resource.size})`
          );
          assert(
            `sha256:${sha256Hex(bytes)}` === resource.digest,
            `digest mismatch for ${resource.uri}`
          );
          if (pathFromUri(resource.uri, skill.name) === "SKILL.md") {
            const text = bytes.toString("utf8");
            assert(text.startsWith("---"), `SKILL.md for ${skill.name} lacks frontmatter`);
            assert(
              text.includes(`name: ${skill.name}`),
              `SKILL.md frontmatter name mismatch for ${skill.name}`
            );
          }
          files += 1;
        }
      }
      return `${files} files verified byte-exact`;
    }
  );

  await check(
    "MOD-08",
    "modern cache hints are private with explicit ttl",
    { era: "modern" },
    async () => {
      if (!state.cacheHints) throw skip("catalog discovery failed");
      const { ttlMs, cacheScope } = state.cacheHints;
      assert(cacheScope === "private", `skills/list cacheScope is ${cacheScope}, expected private`);
      assert(ttlMs === 0, `skills/list ttlMs is ${ttlMs}, expected 0`);
      assert(
        state.catalog.some((skill) =>
          skill.resources.some((resource) => resource.uri === skill.uri)
        ),
        "no SKILL.md resource to sample"
      );
      const sample = state.catalog[0];
      const read = await client.request("resources/read", { uri: sample.uri }, { modern: true });
      assert(
        read.message.result.cacheScope === "private",
        `resources/read cacheScope is ${read.message.result.cacheScope}`
      );
      assert(
        read.message.result.ttlMs === 0,
        `resources/read ttlMs is ${read.message.result.ttlMs}, expected 0`
      );
      return `list ttl=${ttlMs}ms, read ttl=${read.message.result.ttlMs}ms`;
    }
  );

  await check(
    "MOD-09",
    "no dotfiles or unlisted files are exposed",
    { era: "modern" },
    async () => {
      if (!state.catalog.length) throw skip("catalog discovery failed");
      const listed = new Set(
        state.catalog.flatMap((skill) => skill.resources.map((resource) => resource.uri))
      );
      for (const uri of listed) {
        assert(!/(^|\/)\.(?!well-known)/.test(uri), `dotfile resource listed: ${uri}`);
        assert(!uri.includes(".."), `traversal-like resource listed: ${uri}`);
      }
      return `${listed.size} approved resources, 0 dotfiles`;
    }
  );

  await check(
    "MOD-10",
    "tools/list exposes the three fallback tools only",
    { era: "modern" },
    async () => {
      const { message } = await client.request("tools/list", {}, { modern: true });
      const tools = (message.result?.tools ?? []).map((tool) => tool.name).sort();
      assert(
        JSON.stringify(tools) === JSON.stringify(FALLBACK_TOOLS),
        `unexpected tool set: ${JSON.stringify(tools)}`,
        { expected: FALLBACK_TOOLS, actual: tools }
      );
      for (const tool of message.result.tools) {
        assert(tool.inputSchema?.type === "object", `tool ${tool.name} has no object inputSchema`);
        assert(
          typeof tool.description === "string" && tool.description.length > 0,
          `tool ${tool.name} lacks description`
        );
      }
      state.tools = tools;
      return tools.join(", ");
    }
  );

  await check(
    "MOD-11",
    "get_skill returns the same instructions and manifest",
    { era: "modern" },
    async () => {
      if (!state.catalog.length) throw skip("catalog discovery failed");
      for (const skill of state.catalog) {
        const { message } = await client.request(
          "tools/call",
          { name: "get_skill", arguments: { name: skill.name } },
          { modern: true }
        );
        assert(!message.result?.isError, `get_skill failed for ${skill.name}`, message.result);
        const payload = toolJson(message.result);
        assert(payload.name === skill.name, `get_skill name mismatch for ${skill.name}`, payload);
        assert(
          typeof payload.instructions === "string" && payload.instructions.length > 0,
          `get_skill instructions missing for ${skill.name}`
        );
        const files = new Map((payload.files ?? []).map((file) => [file.uri, file]));
        assert(
          files.size === skill.resources.length,
          `get_skill file count differs for ${skill.name}`
        );
        for (const resource of skill.resources) {
          const file = files.get(resource.uri);
          assert(file, `get_skill omits ${resource.uri}`);
          assert(
            file.digest === resource.digest && file.size === resource.size,
            `get_skill metadata differs for ${resource.uri}`
          );
        }
      }
      return `${state.catalog.length} skills`;
    }
  );

  await check(
    "MOD-12",
    "get_skill_file bytes match resources/read",
    { era: "modern" },
    async () => {
      if (!state.catalog.length) throw skip("catalog discovery failed");
      let files = 0;
      for (const skill of state.catalog) {
        for (const resource of skill.resources) {
          const path = pathFromUri(resource.uri, skill.name);
          assert(path, `cannot derive path from ${resource.uri}`);
          const { message } = await client.request(
            "tools/call",
            { name: "get_skill_file", arguments: { name: skill.name, path } },
            { modern: true }
          );
          assert(
            !message.result?.isError,
            `get_skill_file failed for ${resource.uri}`,
            message.result
          );
          const payload = toolJson(message.result);
          assert(
            sameUri(payload.uri, resource.uri),
            `get_skill_file uri mismatch for ${resource.uri}`,
            payload
          );
          assert(
            payload.digest === resource.digest,
            `get_skill_file digest mismatch for ${resource.uri}`
          );
          assert(
            `sha256:${sha256Hex(Buffer.from(payload.text, "utf8"))}` === resource.digest,
            `get_skill_file bytes mismatch for ${resource.uri}`
          );
          files += 1;
        }
      }
      return `${files} files verified`;
    }
  );

  await check(
    "MOD-13",
    "search_skills finds every skill by exact name",
    { era: "modern" },
    async () => {
      if (!state.catalog.length) throw skip("catalog discovery failed");
      for (const skill of state.catalog) {
        const { message } = await client.request(
          "tools/call",
          { name: "search_skills", arguments: { query: skill.name, limit: 50 } },
          { modern: true }
        );
        assert(!message.result?.isError, `search_skills failed for ${skill.name}`, message.result);
        const payload = toolJson(message.result);
        assert(
          Array.isArray(payload.skills) &&
            payload.skills.some((entry) => entry.name === skill.name),
          `search_skills did not return ${skill.name}`,
          payload
        );
      }
      return `${state.catalog.length} queries`;
    }
  );

  await check(
    "MOD-14",
    "get_skill_file rejects traversal and unlisted paths",
    { era: "modern" },
    async () => {
      if (!state.catalog.length) throw skip("catalog discovery failed");
      const skill = state.catalog[0];
      const attempts = [
        "../SKILL.md",
        "..%2FSKILL.md",
        "/etc/passwd",
        ".hidden-note.md",
        "references/../../SKILL.md",
        "nope.txt",
      ];
      const allowed = [];
      for (const path of attempts) {
        const { message, status } = await client.rpc(
          "tools/call",
          { name: "get_skill_file", arguments: { name: skill.name, path } },
          { modern: true }
        );
        if (message?.result?.isError === true || message?.error || status >= 400) continue;
        allowed.push(path);
      }
      assert(allowed.length === 0, `unsafe paths accepted: ${allowed.join(", ")}`, {
        skill: skill.name,
      });
      return `${attempts.length} unsafe paths rejected`;
    }
  );

  await check("MOD-15", "unknown skill get and read are rejected", { era: "modern" }, async () => {
    const unknown = "skill://does-not-exist/SKILL.md";
    const get = await client.rpc("skills/get", { uri: unknown }, { modern: true });
    assert(get.message?.error || get.status >= 400, "skills/get accepted an unknown skill", {
      status: get.status,
    });
    const read = await client.rpc("resources/read", { uri: unknown }, { modern: true });
    assert(read.message?.error || read.status >= 400, "resources/read accepted an unknown skill", {
      status: read.status,
    });
    return "skills/get + resources/read rejected";
  });

  await check(
    "MOD-16",
    "authenticated responses are private and never public-cacheable",
    { era: "modern" },
    async () => {
      const { headers } = await client.request("skills/list", {}, { modern: true });
      const cacheControl = (headers.get("cache-control") ?? "").toLowerCase();
      assert(cacheControl.includes("no-store"), `cache-control is "${cacheControl}"`);
      assert(!cacheControl.includes("public"), `cache-control is public: "${cacheControl}"`);
      return cacheControl;
    }
  );

  await check(
    "MOD-17",
    "registered resources and templates stay inside the approved inventory",
    { era: "modern" },
    async () => {
      if (!state.catalog.length) throw skip("catalog discovery failed");
      const approved = new Set(
        state.catalog.flatMap((skill) => skill.resources.map((resource) => resource.uri))
      );
      const list = await client.rpc("resources/list", {}, { modern: true });
      if (list.status === 200 && !list.message?.error) {
        for (const resource of list.message.result?.resources ?? []) {
          assert(
            typeof resource.uri === "string" && approved.has(resource.uri),
            `resources/list exposed unapproved URI ${resource.uri}`,
            resource
          );
        }
      }
      const templates = await client.rpc("resources/templates/list", {}, { modern: true });
      if (templates.status === 200 && !templates.message?.error) {
        for (const template of templates.message.result?.resourceTemplates ?? []) {
          assert(
            template.name === SKILLS_EXTENSION,
            `unexpected resource template name ${template.name}`,
            template
          );
          assert(
            typeof template.uriTemplate === "string" && template.uriTemplate.startsWith("skill://"),
            `unexpected resource template ${template.uriTemplate}`,
            template
          );
        }
      }
      return "resource inventory bounded to approved skills";
    }
  );

  await check(
    "MOD-18",
    "server/discover uses private, zero-ttl cache hints",
    { era: "modern" },
    async () => {
      const { message } = await client.request("server/discover", {}, { modern: true });
      assert(
        message.result?.cacheScope === "private",
        `discover cacheScope is ${message.result?.cacheScope}`
      );
      assert(message.result?.ttlMs === 0, `discover ttlMs is ${message.result?.ttlMs}`);
      return "private, ttl 0";
    }
  );

  await check(
    "MOD-19",
    "skills/get uses private, zero-ttl cache hints",
    { era: "modern" },
    async () => {
      if (!state.catalog.length) throw skip("catalog discovery failed");
      const { message } = await client.request(
        "skills/get",
        { uri: state.catalog[0].uri },
        { modern: true }
      );
      assert(
        message.result?.cacheScope === "private",
        `skills/get cacheScope is ${message.result?.cacheScope}`
      );
      assert(message.result?.ttlMs === 0, `skills/get ttlMs is ${message.result?.ttlMs}`);
      return "private, ttl 0";
    }
  );
}

async function runLegacy(client, state) {
  const initialize = async (version) => {
    const response = await client.rpc(
      "initialize",
      {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: "ega-acceptance", version: "1.0.0" },
      },
      { modern: false }
    );
    return response;
  };

  await check("LEG-01", `initialize negotiates ${LEGACY_VERSION}`, { era: "legacy" }, async () => {
    const response = await initialize(LEGACY_VERSION);
    assert(
      response.status === 200,
      `initialize returned HTTP ${response.status}`,
      truncate(response.raw, 300)
    );
    assert(!response.message?.error, `initialize error: ${response.message?.error?.message}`);
    const negotiated = response.message?.result?.protocolVersion;
    assert(negotiated === LEGACY_VERSION, `negotiated ${negotiated}, expected ${LEGACY_VERSION}`);
    assert(response.message.result.serverInfo?.name, "serverInfo missing");
    return `${response.message.result.serverInfo.name} @ ${negotiated}`;
  });

  await check(
    "LEG-02",
    "legacy initialize advertises the skills extension",
    { era: "legacy" },
    async () => {
      const response = await initialize(LEGACY_VERSION);
      const capabilities = response.message?.result?.capabilities ?? {};
      assert(capabilities.resources, "capabilities.resources missing");
      assert(
        capabilities.extensions?.[SKILLS_EXTENSION],
        `capabilities.extensions["${SKILLS_EXTENSION}"] missing`,
        capabilities
      );
      return JSON.stringify(Object.keys(capabilities));
    }
  );

  await check("LEG-03", "initialized notification is accepted", { era: "legacy" }, async () => {
    const response = await client.rpc("notifications/initialized", {}, { modern: false });
    assert(
      response.status === 200 || response.status === 202 || response.status === 204,
      `notifications/initialized returned ${response.status}`
    );
    return `HTTP ${response.status}`;
  });

  await check(
    "LEG-04",
    "legacy tools/list exposes the same three tools",
    { era: "legacy" },
    async () => {
      const { message } = await client.request("tools/list", {}, { modern: false });
      const tools = (message.result?.tools ?? []).map((tool) => tool.name).sort();
      assert(
        JSON.stringify(tools) === JSON.stringify(FALLBACK_TOOLS),
        `unexpected legacy tool set: ${JSON.stringify(tools)}`
      );
      return tools.join(", ");
    }
  );

  await check("LEG-05", "legacy tools/call behaves identically", { era: "legacy" }, async () => {
    const name = state.catalog[0]?.name;
    assert(name, "modern catalog unavailable; cannot compare legacy call");
    const { message } = await client.request(
      "tools/call",
      { name: "get_skill", arguments: { name } },
      { modern: false }
    );
    assert(!message.result?.isError, `legacy get_skill failed for ${name}`, message.result);
    const payload = toolJson(message.result);
    assert(payload.name === name, "legacy get_skill returned a different skill");
    return `${name} via legacy tools/call`;
  });

  await check(
    "LEG-06",
    "legacy resources/read returns exact bytes",
    { era: "legacy" },
    async () => {
      if (!state.catalog.length)
        throw skip("modern catalog unavailable; exact-byte comparison needs it");
      const skill = state.catalog[0];
      const resource = skill.resources.find((entry) => entry.uri === skill.uri);
      const { message } = await client.request(
        "resources/read",
        { uri: resource.uri },
        { modern: false }
      );
      const bytes = decodeContent(message.result?.contents?.[0]);
      assert(
        `sha256:${sha256Hex(bytes)}` === resource.digest,
        `legacy read digest mismatch for ${resource.uri}`
      );
      return `${resource.uri} verified`;
    }
  );

  await check(
    "LEG-07",
    "an unsupported legacy version is negotiated down, not crashed",
    { era: "legacy" },
    async () => {
      const response = await initialize("1900-01-01");
      if (response.message?.error) return `rejected with ${response.message.error.code}`;
      const negotiated = response.message?.result?.protocolVersion;
      assert(typeof negotiated === "string", "no protocolVersion in initialize result");
      return `negotiated ${negotiated}`;
    }
  );

  await check("LEG-08", "legacy results omit modern cache fields", { era: "legacy" }, async () => {
    const tools = await client.request("tools/list", {}, { modern: false });
    assert(
      !("cacheScope" in (tools.message.result ?? {})) && !("ttlMs" in (tools.message.result ?? {})),
      "legacy tools/list carries modern cache fields",
      tools.message.result
    );
    if (!state.catalog.length) throw skip("catalog unavailable for legacy read sample");
    const read = await client.request(
      "resources/read",
      { uri: state.catalog[0].uri },
      { modern: false }
    );
    assert(
      !("cacheScope" in (read.message.result ?? {})) && !("ttlMs" in (read.message.result ?? {})),
      "legacy resources/read carries modern cache fields",
      read.message.result
    );
    return "no cacheScope/ttlMs in legacy results";
  });

  await check(
    "LEG-09",
    "legacy responses are private and never publicly cacheable",
    { era: "legacy" },
    async () => {
      const { headers } = await client.request("tools/list", {}, { modern: false });
      const cacheControl = (headers.get("cache-control") ?? "").toLowerCase();
      assert(cacheControl.includes("no-store"), `cache-control is "${cacheControl}"`);
      assert(!cacheControl.includes("public"), `cache-control is public: "${cacheControl}"`);
      return cacheControl;
    }
  );
}

async function runCrossEra(client, state) {
  await check(
    "X-01",
    "modern and legacy eras expose the same approved file set",
    { era: "cross" },
    async () => {
      if (!state.catalog.length) throw skip("modern catalog discovery failed");
      const legacy = await client.request("tools/list", {}, { modern: false });
      const legacyTools = (legacy.message.result?.tools ?? []).map((tool) => tool.name).sort();
      assert(
        JSON.stringify(legacyTools) === JSON.stringify(FALLBACK_TOOLS),
        "legacy tool inventory differs from modern"
      );
      const skill = state.catalog[0];
      const modernRead = await client.request(
        "resources/read",
        { uri: skill.uri },
        { modern: true }
      );
      const legacyRead = await client.request(
        "resources/read",
        { uri: skill.uri },
        { modern: false }
      );
      const modernBytes = decodeContent(modernRead.message.result?.contents?.[0]);
      const legacyBytes = decodeContent(legacyRead.message.result?.contents?.[0]);
      assert(modernBytes.equals(legacyBytes), `era byte drift for ${skill.uri}`);
      return `${state.catalog.length} skills, ${skill.uri} byte-identical across eras`;
    }
  );

  await check(
    "X-02",
    "no request leaked an unfiltered catalog copy",
    { era: "cross" },
    async () => {
      const sample = state.catalog.slice(0, 20);
      for (const skill of sample) {
        assert(!/\.hidden/.test(JSON.stringify(skill)), `dotfile leaked in ${skill.name}`);
      }
      return `${sample.length} sampled skills contain no dotfiles`;
    }
  );

  await check(
    "X-03",
    "legacy fallback tools match the modern native catalog and bytes",
    { era: "cross" },
    async () => {
      if (!state.catalog.length) throw skip("modern catalog discovery failed");
      let files = 0;
      for (const skill of state.catalog) {
        const getSkill = await client.request(
          "tools/call",
          { name: "get_skill", arguments: { name: skill.name } },
          { modern: false }
        );
        assert(
          !getSkill.message.result?.isError,
          `legacy get_skill failed for ${skill.name}`,
          getSkill.message.result
        );
        const manifest = toolJson(getSkill.message.result);
        const byUri = new Map((manifest.files ?? []).map((file) => [file.uri, file]));
        assert(
          byUri.size === skill.resources.length,
          `legacy get_skill manifest count differs for ${skill.name}`
        );
        for (const resource of skill.resources) {
          const entry = byUri.get(resource.uri);
          assert(entry, `legacy get_skill omits ${resource.uri}`);
          assert(
            entry.digest === resource.digest && entry.size === resource.size,
            `legacy get_skill metadata differs for ${resource.uri}`
          );

          const path = pathFromUri(resource.uri, skill.name);
          assert(path, `cannot derive path from ${resource.uri}`);
          const nativeRead = await client.request(
            "resources/read",
            { uri: resource.uri },
            { modern: false }
          );
          const fallback = await client.request(
            "tools/call",
            { name: "get_skill_file", arguments: { name: skill.name, path } },
            { modern: false }
          );
          assert(
            !fallback.message.result?.isError,
            `legacy get_skill_file failed for ${resource.uri}`,
            fallback.message.result
          );
          const nativeBytes = decodeContent(nativeRead.message.result?.contents?.[0]);
          const fallbackBytes = Buffer.from(toolJson(fallback.message.result).text, "utf8");
          assert(
            nativeBytes.equals(fallbackBytes),
            `legacy native/fallback byte drift for ${resource.uri}`
          );
          files += 1;
        }
      }
      return `${state.catalog.length} skills, ${files} files identical`;
    }
  );
}

async function runOrigin(client, state, options) {
  const headers = { Origin: "https://evil.example" };

  await check(
    "ORIGIN-01",
    "modern request with a disallowed Origin returns 403",
    { era: "modern" },
    async () => {
      const response = await client.rpc(
        state.legacy && !state.catalog.length ? "initialize" : "skills/list",
        state.legacy && !state.catalog.length
          ? {
              protocolVersion: LEGACY_VERSION,
              capabilities: {},
              clientInfo: { name: "origin", version: "1" },
            }
          : {},
        { modern: !state.legacy || state.catalog.length > 0, extraHeaders: headers }
      );
      assert(response.status === 403, `disallowed Origin got HTTP ${response.status}`, {
        body: truncate(response.raw, 300),
      });
      assert(!/skill:\/\//.test(response.raw), "403 body leaked catalog data");
      return "403 before dispatch";
    }
  );

  await check("ORIGIN-02", "malformed Origin returns 403", { era: "cross" }, async () => {
    const response = await client.rpc(
      "initialize",
      {
        protocolVersion: LEGACY_VERSION,
        capabilities: {},
        clientInfo: { name: "origin", version: "1" },
      },
      { modern: false, extraHeaders: { Origin: "not a url" } }
    );
    assert(response.status === 403, `malformed Origin got HTTP ${response.status}`, {
      body: truncate(response.raw, 300),
    });
    return "403";
  });

  await check(
    "ORIGIN-03",
    "legacy initialize with a disallowed Origin returns 403",
    { era: "legacy" },
    async () => {
      const response = await client.rpc(
        "initialize",
        {
          protocolVersion: LEGACY_VERSION,
          capabilities: {},
          clientInfo: { name: "origin", version: "1" },
        },
        { modern: false, extraHeaders: headers }
      );
      assert(response.status === 403, `legacy disallowed Origin got HTTP ${response.status}`);
      return "403";
    }
  );

  await check(
    "ORIGIN-04",
    "configured allowed Origin reaches the handler",
    { era: "cross" },
    async () => {
      if (!options.allowedOrigin) throw skip("no --allowed-origin supplied");
      const response = await client.rpc(
        "initialize",
        {
          protocolVersion: LEGACY_VERSION,
          capabilities: {},
          clientInfo: { name: "origin", version: "1" },
        },
        { modern: false, extraHeaders: { Origin: options.allowedOrigin } }
      );
      assert(response.status === 200, `allowed Origin got HTTP ${response.status}`, {
        body: truncate(response.raw, 300),
      });
      return "200";
    }
  );
}

async function runRobustness(client, state, options) {
  await check(
    "MAL-01",
    "malformed JSON is rejected without a crash",
    { era: "cross" },
    async () => {
      const response = await fetch(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          ...(state.catalog.length
            ? { "mcp-protocol-version": MODERN_VERSION, "mcp-method": "skills/list" }
            : {}),
        },
        body: "{not-json",
      });
      const text = await response.text();
      assert(
        response.status >= 400 && response.status < 500,
        `malformed JSON got HTTP ${response.status}`
      );
      assert(!/\bat\s+\w+.*\(.*:\d+:\d+\)/.test(text), "response leaked a stack trace");
      return `HTTP ${response.status}`;
    }
  );

  await check(
    "MAL-02",
    "unsupported modern protocol version is rejected",
    { era: "modern" },
    async () => {
      const response = await fetch(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          "mcp-protocol-version": "1900-01-01",
          "mcp-method": "server/discover",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9901,
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "1900-01-01",
              "io.modelcontextprotocol/clientInfo": { name: "acceptance", version: "1" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      const text = await response.text();
      assert(
        response.status >= 400 && response.status < 500,
        `unsupported version got HTTP ${response.status}`,
        {
          body: truncate(text, 300),
        }
      );
      return `HTTP ${response.status}`;
    }
  );

  await check(
    "CUR-01",
    "malformed cursor is rejected, never ignored",
    { era: "modern" },
    async () => {
      const response = await client.rpc(
        "skills/list",
        { cursor: "!!not-a-cursor!!" },
        { modern: true }
      );
      assert(response.status !== 500, "invalid cursor caused HTTP 500", {
        body: truncate(response.raw, 300),
      });
      assert(
        response.status === 400 || response.status === 422 || response.message?.error,
        `invalid cursor was accepted with HTTP ${response.status}`,
        { body: truncate(response.raw, 300) }
      );
      assert(!/skill:\/\//.test(response.raw), "cursor rejection leaked catalog data");
      if (response.message?.error) {
        assert(
          response.message.error.code === -32602 || response.message.error.code === -32600,
          `invalid cursor returned JSON-RPC code ${response.message.error.code}, expected -32602/-32600`
        );
        return `JSON-RPC error ${response.message.error.code}`;
      }
      return `HTTP ${response.status}`;
    }
  );

  await check(
    "CUR-02",
    "cursor variants are rejected without a 5xx or catalog leak",
    { era: "modern" },
    async () => {
      const variants = [
        "",
        "0",
        "not base64!",
        "eyJvZmZzZXQiOjF9",
        "../SKILL.md",
        "A".repeat(4096),
      ];
      const accepted = [];
      for (const cursor of variants) {
        const response = await client.rpc("skills/list", { cursor }, { modern: true });
        const rejected =
          response.status === 400 ||
          response.status === 422 ||
          response.message?.error?.code === -32602 ||
          response.message?.error?.code === -32600;
        if (!rejected) accepted.push(cursor.slice(0, 24));
        assert(response.status !== 500, `cursor variant caused HTTP 500: ${cursor.slice(0, 24)}`);
        assert(!/skill:\/\//.test(response.raw), "cursor rejection leaked catalog data");
      }
      assert(accepted.length === 0, `cursor variants accepted: ${accepted.join(", ")}`);
      return `${variants.length} malformed cursors rejected`;
    }
  );
}

async function runAuth(client, options) {
  await check("AUTH-01", "unauthenticated /mcp returns a Bearer challenge", {}, async () => {
    const anonymous = new McpClient({ url: options.url, token: "", timeoutMs: options.timeoutMs });
    const response = await anonymous.rpc("skills/list", {}, { modern: true });
    assert(
      response.status === 401,
      `expected 401 without a token, got ${response.status}`,
      truncate(response.raw, 300)
    );
    const challenge = response.headers.get("www-authenticate") ?? "";
    assert(/^Bearer/i.test(challenge), `WWW-Authenticate is "${challenge}"`);
    assert(
      challenge.includes("resource_metadata="),
      `challenge lacks resource_metadata: "${challenge}"`
    );
    assert(!/skill:\/\//.test(response.raw), "401 body leaked catalog data");
    const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    if (prmUrl) {
      const prm = await fetch(prmUrl, { redirect: "manual" });
      assert(prm.status === 200, `protected-resource metadata returned ${prm.status}`);
      const metadata = await prm.json();
      assert(
        typeof metadata.resource === "string" && metadata.resource.endsWith("/mcp"),
        `PRM resource is ${metadata.resource}`
      );
      assert(
        Array.isArray(metadata.scopes_supported) && metadata.scopes_supported.length > 0,
        "PRM lacks scopes_supported"
      );
      return `401 + ${prmUrl} (${metadata.scopes_supported.join(",")})`;
    }
    return "401 challenge present (resource_metadata URL absent)";
  });

  await check("AUTH-02", "root protected-resource metadata is not served", {}, async () => {
    const origin = new URL(options.url).origin;
    const root = await fetch(`${origin}/.well-known/oauth-protected-resource`, {
      redirect: "manual",
    });
    assert(root.status === 404, `root PRM returned ${root.status}, expected 404`);
    return "404 at origin root";
  });

  await check("AUTH-03", "authorization-server metadata is discoverable", {}, async () => {
    const origin = new URL(options.url).origin;
    const response = await fetch(`${origin}/.well-known/oauth-authorization-server`, {
      redirect: "manual",
    });
    if (response.status === 404)
      throw skip("authorization server metadata not exposed by this endpoint");
    assert(response.status === 200, `authorization metadata returned ${response.status}`);
    const metadata = await response.json();
    assert(metadata.authorization_endpoint, "authorization_endpoint missing");
    assert(metadata.token_endpoint, "token_endpoint missing");
    return `issuer=${metadata.issuer ?? "unset"}`;
  });

  await check("AUTH-04", "wrong bearer token is rejected without catalog leakage", {}, async () => {
    const wrong = new McpClient({
      url: options.url,
      token: `${options.token || "invalid"}-wrong`,
      timeoutMs: options.timeoutMs,
    });
    const response = await wrong.rpc("skills/list", {}, { modern: true });
    assert(
      response.status === 401 || response.status === 403,
      `wrong token got HTTP ${response.status}`
    );
    assert(!/skill:\/\//.test(response.raw), "wrong-token body leaked catalog data");
    return `HTTP ${response.status}, no catalog bytes`;
  });
}

function toolJson(result) {
  const text = result?.structuredContent
    ? JSON.stringify(result.structuredContent)
    : result?.content?.find((entry) => entry.type === "text")?.text;
  assert(typeof text === "string", "tool result has no text payload", result);
  try {
    return JSON.parse(text);
  } catch {
    throw fail("tool result text is not JSON", truncate(String(text), 300));
  }
}

main().catch((error) => {
  console.error(`acceptance crashed: ${error?.stack ?? error}`);
  process.exit(1);
});
