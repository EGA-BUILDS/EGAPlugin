import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const protocolDir = path.join(repoRoot, "tests/protocol");
const fixtureDir = path.join(protocolDir, "fixture");
const fixtureInstalled = existsSync(path.join(fixtureDir, "node_modules"));
const rootSdkInstalled = existsSync(
  path.join(repoRoot, "node_modules/@modelcontextprotocol/client/package.json")
);
const externalUrl = process.env.MCP_TEST_URL?.trim() ?? "";
const allowedOrigin = process.env.ALLOWED_ORIGIN?.trim() || "https://allowed.example";

let server: ChildProcess | undefined;
let fixtureUrl: string | undefined;
let artifactDir: string | undefined;

afterAll(async () => {
  server?.kill("SIGTERM");
  if (artifactDir) await rm(artifactDir, { recursive: true, force: true });
});

describe("V010-008 local protocol verification", () => {
  it.skipIf(!externalUrl && !fixtureInstalled)(
    "passes wire-level modern, legacy, parity, Origin, and cursor checks",
    async () => {
      const url = externalUrl || (await startFixture());
      artifactDir ??= await mkdtemp(path.join(tmpdir(), "ega-protocol-"));
      const result = await runNode(
        path.join(protocolDir, "mcp-suite.mjs"),
        [
          "--url",
          url,
          "--allowed-origin",
          allowedOrigin,
          "--json-out",
          path.join(artifactDir, "wire.json"),
        ],
        120_000
      );
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain("RESULT: PASS");
    },
    150_000
  );

  it.skipIf(!externalUrl && !fixtureInstalled)(
    "passes official client modern and legacy negotiation with native/fallback parity",
    async () => {
      const url = externalUrl || (await startFixture());
      const sdkRoot = rootSdkInstalled ? repoRoot : fixtureDir;
      if (!rootSdkInstalled && !fixtureInstalled) return;
      artifactDir ??= await mkdtemp(path.join(tmpdir(), "ega-protocol-"));
      const result = await runNode(
        path.join(protocolDir, "official-client.mjs"),
        [
          "--url",
          url,
          "--sdk-root",
          sdkRoot,
          "--json-out",
          path.join(artifactDir, "official-client.json"),
        ],
        120_000
      );
      // Exit 2 means the pinned SDK is unavailable, not a protocol failure.
      if (result.code === 2) return;
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain("RESULT: PASS");
    },
    150_000
  );
});

async function startFixture(): Promise<string> {
  if (fixtureUrl) return fixtureUrl;
  if (!server) {
    server = spawn(
      process.execPath,
      [path.join(fixtureDir, "server.mjs"), "--port", "0", "--allowed-origin", allowedOrigin],
      { cwd: fixtureDir, stdio: ["ignore", "pipe", "pipe"] }
    );
  }
  const child = server;
  if (!child) throw new Error("fixture process did not start");
  fixtureUrl = await waitForListening(child);
  return fixtureUrl;
}

function waitForListening(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`fixture did not start within 20s: ${stderr}`)),
      20_000
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = /LISTENING (http:\/\/\S+)/.exec(buffer);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(`${match[1]}/mcp`);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited with ${code} before listening: ${stderr}`));
    });
  });
}

function runNode(
  script: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: null, output: `${output}\ntimeout after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}
