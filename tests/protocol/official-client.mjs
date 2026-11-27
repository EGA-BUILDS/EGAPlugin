#!/usr/bin/env node
// Official-SDK protocol verification for EGAPlugin (SPEC-001 Revision 7 §12.4).
//
// Uses the pinned `@modelcontextprotocol/client@2.4.0` public APIs:
//   - `Client` + `StreamableHTTPClientTransport` for both protocol eras
//   - `SkillsClient` for native SEP-2640 discovery and verified reads
//   - `client.callTool` for the three fallback tools
//
// The suite runs the same catalog through modern (2026-07-28, pinned) and
// legacy (2025-era initialize) negotiation, checks native and fallback parity,
// and requires malformed cursors to be rejected by the official client path.
//
// It is read-only, prints no credentials, and targets only the endpoint given
// with --url. It never mints tokens or bypasses authorization.
//
// Usage:
//   node tests/protocol/official-client.mjs --url http://127.0.0.1:4319/mcp \
//     --sdk-root tests/protocol/fixture
//   MCP_TOKEN=... node tests/protocol/official-client.mjs --url ... --token-env MCP_TOKEN
//
// Exit: 0 all checks pass, 1 failure, 2 pinned client SDK unavailable.

import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const MODERN_VERSION = "2026-07-28";
const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
const FALLBACK_TOOLS = ["get_skill", "get_skill_file", "search_skills"];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {
    url: "",
    token: "",
    tokenEnv: "",
    jsonOut: "",
    sdkRoot: path.join(scriptDir, "fixture"),
    timeoutMs: 20_000,
    modernOnly: false,
    legacyOnly: false,
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
      case "--json-out":
        options.jsonOut = next();
        break;
      case "--sdk-root":
        options.sdkRoot = path.resolve(next());
        break;
      case "--timeout":
        options.timeoutMs = Number(next()) * 1000;
        break;
      case "--modern-only":
        options.modernOnly = true;
        break;
      case "--legacy-only":
        options.legacyOnly = true;
        break;
      case "--help":
      case "-h":
        console.log(`EGAPlugin official MCP client verification

  --url <url>          MCP endpoint (required)
  --token-env <name>   Environment variable holding a bearer token
  --token <token>      Inline token (prefer --token-env)
  --sdk-root <dir>     Directory whose node_modules contains the pinned client SDK
  --json-out <path>    Write a machine-readable report
  --timeout <seconds>  Per-request timeout (default 20)
  --modern-only        Skip legacy-era checks
  --legacy-only        Skip modern-era checks

Requires @modelcontextprotocol/client@2.4.0 with its ext/skills subpath.`);
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

function resolveFrom(root, specifier) {
  return createRequire(path.join(root, "package.json")).resolve(specifier);
}

async function loadSdk(root) {
  const clientEntry = resolveFrom(root, "@modelcontextprotocol/client");
  const skillsEntry = resolveFrom(root, "@modelcontextprotocol/client/ext/skills");
  const client = await import(pathToFileURL(clientEntry).href);
  const skills = await import(pathToFileURL(skillsEntry).href);
  if (
    typeof client.Client !== "function" ||
    typeof client.StreamableHTTPClientTransport !== "function"
  ) {
    throw new Error("pinned client SDK lacks Client/StreamableHTTPClientTransport");
  }
  if (typeof skills.SkillsClient !== "function") {
    throw new Error("pinned client SDK lacks ext/skills SkillsClient");
  }
  return { ...client, ...skills };
}

const report = {
  tool: "ega-plugin-official-client-verification",
  version: "1.0.0",
  startedAt: new Date().toISOString(),
  checks: [],
};

function record(id, status, detail = "") {
  report.checks.push({ id, status, detail });
  console.log(`  ${status.toUpperCase().padEnd(5)} ${id}${detail ? ` — ${detail}` : ""}`);
}

async function check(id, title, body) {
  try {
    const detail = await body();
    record(id, "pass", detail ?? title);
    return true;
  } catch (error) {
    record(id, "fail", error?.message ?? String(error));
    return false;
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function toolJson(result) {
  const text =
    result?.structuredContent !== undefined
      ? JSON.stringify(result.structuredContent)
      : result?.content?.find((entry) => entry.type === "text")?.text;
  assert(typeof text === "string", "tool result has no text payload");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("tool result text is not JSON");
  }
}

function skillName(entry) {
  return entry?.frontmatter?.name ?? entry?.uri;
}

function resourcePath(entry, uri) {
  const name = skillName(entry);
  for (const prefix of [`skill://${encodeURIComponent(name)}/`, `skill://${name}/`]) {
    if (typeof uri === "string" && uri.startsWith(prefix)) {
      return decodeURIComponent(uri.slice(prefix.length));
    }
  }
  return undefined;
}

function sameUri(left, right) {
  const decode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  return left === right || decode(left) === decode(right);
}

function contentBytes(content) {
  assert(content, "resource content missing");
  if (typeof content.text === "string") return Buffer.from(content.text, "utf8");
  assert(typeof content.blob === "string", "resource content has neither text nor blob");
  return Buffer.from(content.blob, "base64");
}

function makeTransport(sdk, options) {
  return new sdk.StreamableHTTPClientTransport(new URL(options.url), {
    ...(options.token
      ? { requestInit: { headers: { Authorization: `Bearer ${options.token}` } } }
      : {}),
  });
}

function makeClient(sdk, name, negotiation) {
  return new sdk.Client({ name, version: "1.0.0" }, { versionNegotiation: negotiation });
}

async function runModern(sdk, options, catalog) {
  const client = makeClient(sdk, "ega-protocol-modern", { mode: { pin: MODERN_VERSION } });
  const skills = new sdk.SkillsClient(client);
  try {
    await check("SDK-MOD-01", "official client pins modern negotiation", async () => {
      await client.connect(makeTransport(sdk, options), { timeout: options.timeoutMs });
      const negotiated = client.getNegotiatedProtocolVersion();
      assert(
        negotiated === MODERN_VERSION,
        `negotiated ${negotiated ?? "nothing"}, expected ${MODERN_VERSION}`
      );
      return `negotiated ${negotiated}`;
    });

    await check("SDK-MOD-02", "modern capabilities advertise resources + skills", async () => {
      const capabilities = client.getServerCapabilities() ?? {};
      assert(capabilities.resources, "resources capability missing");
      assert(
        capabilities.extensions?.[SKILLS_EXTENSION],
        `extensions[${SKILLS_EXTENSION}] missing`
      );
      return JSON.stringify(Object.keys(capabilities));
    });

    await check("SDK-MOD-03", "SkillsClient accepts every listed entry", async () => {
      assert(skills.supported, "SkillsClient does not see the skills extension");
      const listing = await skills.list();
      assert(listing.skills.length > 0, "skills/list returned no entries");
      assert(listing.invalid.length === 0, `${listing.invalid.length} invalid entries`);
      catalog.modern = listing.skills;
      return `${listing.skills.length} skills, 0 invalid`;
    });

    await check("SDK-MOD-04", "SkillsClient verifies every file digest and size", async () => {
      assert(catalog.modern?.length, "modern catalog unavailable");
      let files = 0;
      for (const entry of catalog.modern) {
        const manifest = await skills.read(entry);
        assert(manifest.verified, `${skillName(entry)}: SKILL.md not verified`);
        files += 1;
        for (const resource of entry.resources ?? []) {
          const path = resourcePath(entry, resource.uri);
          assert(path, `cannot derive path from ${resource.uri}`);
          if (path === "SKILL.md") continue;
          const file = await skills.read(entry, path);
          assert(file.verified, `${resource.uri} not verified`);
          assert(
            file.bytes.byteLength === resource.size,
            `${resource.uri} size ${file.bytes.byteLength} != ${resource.size}`
          );
          assert(sha256(file.bytes) === resource.digest, `${resource.uri} digest mismatch`);
          files += 1;
        }
      }
      return `${catalog.modern.length} skills, ${files} files verified`;
    });

    await check("SDK-MOD-05", "direct skills.get matches the listing", async () => {
      assert(catalog.modern?.length, "modern catalog unavailable");
      for (const entry of catalog.modern) {
        const direct = await skills.get(entry.uri);
        assert(direct.skill.uri === entry.uri, `skills.get uri mismatch for ${entry.uri}`);
        assert(
          JSON.stringify(direct.skill.resources) === JSON.stringify(entry.resources),
          `skills.get manifest differs for ${entry.uri}`
        );
      }
      return `${catalog.modern.length} direct lookups`;
    });

    await check("SDK-MOD-06", "malformed cursor is rejected by the official client", async () => {
      let rejected = false;
      try {
        await skills.list({ cursor: "!!not-a-cursor!!" });
      } catch {
        rejected = true;
      }
      assert(rejected, "SkillsClient accepted a malformed cursor");
      return "rejected";
    });

    await check("SDK-MOD-07", "fallback get_skill matches native manifests", async () => {
      assert(catalog.modern?.length, "modern catalog unavailable");
      for (const entry of catalog.modern) {
        const result = await client.callTool({
          name: "get_skill",
          arguments: { name: skillName(entry) },
        });
        assert(!result.isError, `get_skill failed for ${skillName(entry)}`);
        const payload = toolJson(result);
        assert(payload.name === skillName(entry), `get_skill name mismatch`);
        assert(
          typeof payload.instructions === "string" && payload.instructions.length > 0,
          `get_skill instructions missing for ${skillName(entry)}`
        );
        const byUri = new Map((payload.files ?? []).map((file) => [file.uri, file]));
        assert(
          byUri.size === entry.resources.length,
          `get_skill file count differs for ${skillName(entry)}`
        );
        for (const resource of entry.resources) {
          const file = byUri.get(resource.uri);
          assert(file, `get_skill omits ${resource.uri}`);
          assert(
            file.digest === resource.digest && file.size === resource.size,
            `get_skill metadata differs for ${resource.uri}`
          );
        }
      }
      return `${catalog.modern.length} skills`;
    });

    await check("SDK-MOD-08", "fallback get_skill_file matches native bytes", async () => {
      assert(catalog.modern?.length, "modern catalog unavailable");
      let files = 0;
      for (const entry of catalog.modern) {
        const native = new Map();
        for (const resource of entry.resources) {
          const path = resourcePath(entry, resource.uri);
          if (!path) throw new Error(`cannot derive path from ${resource.uri}`);
          const file = await skills.read(entry, path);
          native.set(resource.uri, file.bytes);
        }
        for (const resource of entry.resources) {
          const path = resourcePath(entry, resource.uri);
          const result = await client.callTool({
            name: "get_skill_file",
            arguments: { name: skillName(entry), path },
          });
          assert(!result.isError, `get_skill_file failed for ${resource.uri}`);
          const payload = toolJson(result);
          assert(sameUri(payload.uri, resource.uri), `get_skill_file uri mismatch`);
          assert(payload.digest === resource.digest, `get_skill_file digest mismatch`);
          const fallbackBytes = Buffer.from(payload.text, "utf8");
          assert(
            fallbackBytes.equals(Buffer.from(native.get(resource.uri))),
            `get_skill_file bytes differ from native read for ${resource.uri}`
          );
          files += 1;
        }
      }
      return `${files} files byte-identical`;
    });

    await check("SDK-MOD-09", "search_skills finds every approved skill", async () => {
      assert(catalog.modern?.length, "modern catalog unavailable");
      for (const entry of catalog.modern) {
        const result = await client.callTool({
          name: "search_skills",
          arguments: { query: skillName(entry), limit: 50 },
        });
        assert(!result.isError, `search_skills failed for ${skillName(entry)}`);
        const payload = toolJson(result);
        assert(
          payload.skills?.some((skill) => skill.name === skillName(entry)),
          `search_skills did not return ${skillName(entry)}`
        );
      }
      return `${catalog.modern.length} queries`;
    });

    await check("SDK-MOD-10", "fallback tools reject unknown skills and files", async () => {
      if (!catalog.modern?.length) return "skipped: modern catalog unavailable";
      const unknownSkill = await client.callTool({
        name: "get_skill",
        arguments: { name: "does-not-exist" },
      });
      assert(unknownSkill.isError === true, "get_skill accepted an unknown skill");
      const unknownFile = await client.callTool({
        name: "get_skill_file",
        arguments: { name: skillName(catalog.modern[0]), path: "not-approved.txt" },
      });
      assert(unknownFile.isError === true, "get_skill_file accepted an unlisted path");
      return "unknown skill and unlisted file rejected";
    });
  } finally {
    await client.close().catch(() => {});
  }
}

async function runLegacy(sdk, options, catalog) {
  const client = makeClient(sdk, "ega-protocol-legacy", { mode: "legacy" });
  const skills = new sdk.SkillsClient(client);
  try {
    await check("SDK-LEG-01", "official client negotiates a 2025-era revision", async () => {
      await client.connect(makeTransport(sdk, options), { timeout: options.timeoutMs });
      const negotiated = client.getNegotiatedProtocolVersion();
      assert(
        typeof negotiated === "string" && negotiated.startsWith("2025-"),
        `negotiated ${negotiated ?? "nothing"}, expected a 2025-era revision`
      );
      return `negotiated ${negotiated}`;
    });

    await check("SDK-LEG-02", "legacy initialize advertises resources + skills", async () => {
      const capabilities = client.getServerCapabilities() ?? {};
      assert(capabilities.resources, "resources capability missing");
      assert(
        capabilities.extensions?.[SKILLS_EXTENSION],
        `extensions[${SKILLS_EXTENSION}] missing`
      );
      return JSON.stringify(Object.keys(capabilities));
    });

    await check("SDK-LEG-03", "legacy tools/list exposes the fallback set only", async () => {
      const result = await client.listTools();
      const tools = (result.tools ?? []).map((tool) => tool.name).sort();
      assert(
        JSON.stringify(tools) === JSON.stringify(FALLBACK_TOOLS),
        `unexpected legacy tool set: ${JSON.stringify(tools)}`
      );
      return tools.join(", ");
    });

    await check("SDK-LEG-04", "legacy fallback get_skill returns the manifest", async () => {
      if (!catalog.modern?.length) return "skipped: modern catalog unavailable for parity";
      for (const entry of catalog.modern) {
        const result = await client.callTool({
          name: "get_skill",
          arguments: { name: skillName(entry) },
        });
        assert(!result.isError, `legacy get_skill failed for ${skillName(entry)}`);
        const payload = toolJson(result);
        const byUri = new Map((payload.files ?? []).map((file) => [file.uri, file]));
        assert(
          byUri.size === entry.resources.length,
          `legacy get_skill file count differs for ${skillName(entry)}`
        );
        for (const resource of entry.resources) {
          const file = byUri.get(resource.uri);
          assert(file, `legacy get_skill omits ${resource.uri}`);
          assert(
            file.digest === resource.digest && file.size === resource.size,
            `legacy get_skill metadata differs for ${resource.uri}`
          );
        }
      }
      return `${catalog.modern.length} skills`;
    });

    await check("SDK-LEG-05", "legacy native read and fallback bytes match modern", async () => {
      if (!catalog.modern?.length) return "skipped: modern catalog unavailable for parity";
      let files = 0;
      for (const entry of catalog.modern) {
        for (const resource of entry.resources) {
          const path = resourcePath(entry, resource.uri);
          assert(path, `cannot derive path from ${resource.uri}`);
          const read = await client.readResource({ uri: resource.uri });
          const content = read.contents?.[0];
          assert(content?.uri && sameUri(content.uri, resource.uri), `legacy read uri mismatch`);
          const bytes = contentBytes(content);
          assert(bytes.byteLength === resource.size, `legacy read size mismatch`);
          assert(sha256(bytes) === resource.digest, `legacy read digest mismatch`);

          const fallback = await client.callTool({
            name: "get_skill_file",
            arguments: { name: skillName(entry), path },
          });
          assert(!fallback.isError, `legacy get_skill_file failed for ${resource.uri}`);
          assert(
            Buffer.from(toolJson(fallback).text, "utf8").equals(bytes),
            `legacy native/fallback byte drift for ${resource.uri}`
          );
          files += 1;
        }
      }
      return `${catalog.modern.length} skills, ${files} files identical`;
    });

    await check("SDK-LEG-06", "legacy SkillsClient parity when advertised", async () => {
      if (!skills.supported) return "skipped: client did not mark the extension usable";
      if (!catalog.modern?.length) return "skipped: modern catalog unavailable for parity";
      const listing = await skills.list();
      assert(listing.invalid.length === 0, `${listing.invalid.length} invalid entries`);
      assert(
        listing.skills.length === catalog.modern.length,
        `legacy ${listing.skills.length} skills != modern ${catalog.modern.length}`
      );
      let files = 0;
      for (const entry of listing.skills) {
        const manifest = await skills.read(entry);
        assert(manifest.verified, `${skillName(entry)}: legacy SKILL.md not verified`);
        files += 1;
        for (const resource of entry.resources ?? []) {
          const path = resourcePath(entry, resource.uri);
          if (path === "SKILL.md") continue;
          const file = await skills.read(entry, path);
          assert(file.verified, `${resource.uri} not verified over legacy`);
          assert(sha256(file.bytes) === resource.digest, `${resource.uri} digest mismatch`);
          files += 1;
        }
      }
      return `${listing.skills.length} skills, ${files} files verified over legacy`;
    });

    await check("SDK-LEG-07", "malformed cursor is rejected in the legacy era", async () => {
      let rejected = false;
      try {
        await skills.list({ cursor: "!!not-a-cursor!!" });
      } catch {
        rejected = true;
      }
      assert(rejected, "legacy SkillsClient accepted a malformed cursor");
      return "rejected";
    });
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  report.target = options.url;
  report.authMode = options.token ? "bearer" : "none";
  report.sdkRoot = options.sdkRoot;

  console.log("EGAPlugin official MCP client verification");
  console.log(`target: ${options.url}`);
  console.log(`sdk root: ${options.sdkRoot}`);
  console.log("");

  let sdk;
  try {
    sdk = await loadSdk(options.sdkRoot);
  } catch (error) {
    console.error(`INCOMPLETE: ${error.message}`);
    console.error("Install the pinned client SDK (fixture or root) and rerun.");
    report.incomplete = error.message;
    if (options.jsonOut) {
      await writeFile(options.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.exit(2);
  }

  const catalog = { modern: undefined };
  if (!options.legacyOnly) await runModern(sdk, options, catalog);
  if (!options.modernOnly) await runLegacy(sdk, options, catalog);

  const failures = report.checks.filter((entry) => entry.status === "fail");
  report.finishedAt = new Date().toISOString();
  report.exitCode = failures.length > 0 ? 1 : 0;
  console.log("");
  console.log(`summary: ${report.checks.length - failures.length} pass, ${failures.length} fail`);
  console.log(failures.length ? "RESULT: FAIL" : "RESULT: PASS");
  if (options.jsonOut) {
    await writeFile(options.jsonOut, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`report: ${options.jsonOut}`);
  }
  process.exit(report.exitCode);
}

main().catch((error) => {
  console.error(`official client verification crashed: ${error?.stack ?? error}`);
  process.exit(1);
});
