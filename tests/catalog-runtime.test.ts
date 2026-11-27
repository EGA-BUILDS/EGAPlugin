import { expect, it } from "vitest";
import { CATALOG } from "../generated/skills";
import { type CatalogSkill, verifyThreeWayIntegrity } from "../scripts/build-skills";
import { createStaticCatalog } from "../src/catalog";
import { createMcpRuntime } from "../src/mcp";

it("serves every canonical catalog entry and resource through the release MCP runtime", async () => {
  const runtime = createMcpRuntime(createStaticCatalog(CATALOG));
  async function rpc<T>(method: string, params: object = {}, legacy = false): Promise<T> {
    const version = legacy ? "2025-11-25" : "2026-07-28";
    const name = "uri" in params ? params.uri : "name" in params ? params.name : undefined;
    const response = await runtime.fetch(
      new Request("https://ega-plugin.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": version,
          ...(!legacy && { "mcp-method": method }),
          ...(!legacy && typeof name === "string" && { "mcp-name": name }),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            ...(!legacy && {
              _meta: {
                "io.modelcontextprotocol/clientInfo": {
                  name: "catalog-integrity",
                  version: "1.0.0",
                },
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              },
            }),
          },
        }),
      })
    );
    const raw = await response.text();
    expect(response.status, `${method}: ${raw}`).toBe(200);
    const payload = response.headers.get("content-type")?.includes("text/event-stream")
      ? raw
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6)
      : raw;
    const body = JSON.parse(payload!) as { result?: T; error?: unknown };
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    return body.result!;
  }

  const capabilities = {
    resources: expect.any(Object),
    extensions: { "io.modelcontextprotocol/skills": expect.any(Object) },
  };
  expect(await rpc("server/discover")).toMatchObject({ capabilities });
  expect(
    await rpc(
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "catalog-integrity", version: "1.0.0" },
      },
      true
    )
  ).toMatchObject({ protocolVersion: "2025-11-25", capabilities });

  async function tool(name: string, args: object, legacy: boolean): Promise<unknown> {
    const result = await rpc<{ content: { text: string }[]; isError?: boolean }>(
      "tools/call",
      { name, arguments: args },
      legacy
    );
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return JSON.parse(result.content[0]!.text);
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
  for (const legacy of [false, true]) {
    expect(await rpc("resources/list", {}, legacy)).toMatchObject({ resources: [] });
    expect(await rpc("resources/templates/list", {}, legacy)).toMatchObject({
      resourceTemplates: expect.any(Array),
    });
    expect(await tool("search_skills", { limit: 10 }, legacy)).toEqual({
      skills: skills.map(({ uri, frontmatter: { name, description } }) => ({
        uri,
        name,
        description,
      })),
    });
    for (const skill of skills) {
      const name = skill.frontmatter.name;
      expect(await tool("get_skill", { name }, legacy)).toEqual({
        name,
        uri: skill.uri,
        instructions: CATALOG.files[skill.uri],
        files: skill.resources.map(({ uri, digest, size }) => ({ uri, digest, size })),
      });
      for (const { uri, digest, size } of skill.resources) {
        const path = decodeURIComponent(uri.slice(`skill://${name}/`.length));
        expect(await tool("get_skill_file", { name, path }, legacy)).toEqual({
          uri,
          text: CATALOG.files[uri],
          digest,
          size,
        });
      }
    }
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
