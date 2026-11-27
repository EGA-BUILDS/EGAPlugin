import { expect, it } from "vitest";
import { CATALOG } from "../generated/skills";
import { type CatalogSkill, verifyThreeWayIntegrity } from "../scripts/build-skills";
import { createStaticCatalog } from "../src/catalog";
import { createMcpRuntime } from "../src/mcp";

it("serves every canonical catalog entry and resource through the release MCP runtime", async () => {
  const runtime = createMcpRuntime(createStaticCatalog(CATALOG));
  async function rpc<T>(method: string, params: object = {}): Promise<T> {
    const response = await runtime.fetch(
      new Request("https://ega-plugin.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...("uri" in params && typeof params.uri === "string" ? { "mcp-name": params.uri } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/clientInfo": { name: "catalog-integrity", version: "1.0.0" },
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            },
          },
        }),
      })
    );
    const raw = await response.text();
    expect(response.status, `${method}: ${raw}`).toBe(200);
    const body = JSON.parse(raw) as { result?: T; error?: unknown };
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    return body.result!;
  }

  const first = await rpc<{ skills: CatalogSkill[]; nextCursor: string }>("skills/list");
  expect(first.skills).toHaveLength(5);
  expect(first.nextCursor).toBeTypeOf("string");
  const last = await rpc<{ skills: CatalogSkill[]; nextCursor?: string }>("skills/list", {
    cursor: first.nextCursor,
  });
  expect(last.nextCursor).toBeUndefined();
  const skills = [...first.skills, ...last.skills];
  for (const skill of skills) {
    expect(await rpc("skills/get", { uri: skill.uri })).toMatchObject({ skill });
  }
  const resources = [];
  for (const { uri } of skills.flatMap((skill) => skill.resources)) {
    const result = await rpc<{ contents: { uri: string; text: string }[] }>("resources/read", {
      uri,
    });
    expect(result.contents).toEqual([{ uri, text: expect.any(String) }]);
    resources.push({ uri, bytes: new TextEncoder().encode(result.contents[0]!.text) });
  }
  const report = await verifyThreeWayIntegrity({
    catalog: {
      ...CATALOG,
      totalBytes: Object.values(CATALOG.files).reduce(
        (total, file) => total + Buffer.byteLength(file),
        0
      ),
    },
    observed: { skills, resources },
  });
  expect(report.issues).toEqual([]);
  expect(report.checked).toEqual({ skills: 7, resources: 19, bytes: 4562 });
});
