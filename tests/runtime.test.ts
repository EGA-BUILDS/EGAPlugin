import { describe, expect, it } from "vitest";
import { authzFailure } from "../src/authz";
import { createSkillSource, sortSkills, type RuntimeCatalog } from "../src/catalog";
import { createMcpRuntime } from "../src/mcp";
import type { Skill } from "@modelcontextprotocol/server/ext/skills";
import type { ServerContext } from "@modelcontextprotocol/server";

const resource = "https://ega-plugin.test/mcp";
const ownerId = "123";
const context: ServerContext = {} as ServerContext;

const auth = {
  token: "redacted",
  audience: resource,
  scope: ["catalog:read"],
  expiresAt: 4_000_000_000,
  clientId: "client",
};

describe("MCP authorization context", () => {
  it("accepts the owner with the required scope, audience and expiry", () => {
    expect(
      authzFailure({ props: { githubUserId: 123 }, auth }, ownerId, resource, "catalog:read", 100)
    ).toBeNull();
  });

  it("rejects another GitHub subject or a missing subject", () => {
    expect(
      authzFailure({ props: { githubUserId: 999 }, auth }, ownerId, resource, "catalog:read", 100)
    ).toBe("owner");
    expect(authzFailure({ auth }, ownerId, resource, "catalog:read", 100)).toBe("owner");
  });

  it("rejects a missing required scope", () => {
    expect(
      authzFailure(
        { props: { githubUserId: 123 }, auth: { ...auth, scope: [] } },
        ownerId,
        resource,
        "catalog:read",
        100
      )
    ).toBe("scope");
  });

  it("rejects a token bound to another resource", () => {
    expect(
      authzFailure(
        {
          props: { githubUserId: 123 },
          auth: { ...auth, audience: "https://other.example/mcp" },
        },
        ownerId,
        resource,
        "catalog:read",
        100
      )
    ).toBe("audience");
  });

  it("rejects an expired or unbounded token", () => {
    expect(
      authzFailure(
        { props: { githubUserId: 123 }, auth: { ...auth, expiresAt: 100 } },
        ownerId,
        resource,
        "catalog:read",
        100
      )
    ).toBe("expired");
    expect(
      authzFailure(
        {
          props: { githubUserId: 123 },
          auth: { ...auth, expiresAt: undefined },
        },
        ownerId,
        resource,
        "catalog:read",
        100
      )
    ).toBe("expired");
  });
});

function skill(name: string): Skill {
  return {
    uri: `skill://${name}/SKILL.md`,
    frontmatter: { name, description: `${name} description` },
    resources: [
      {
        uri: `skill://${name}/SKILL.md`,
        digest: `sha256:${"0".repeat(64)}`,
        size: 10,
      },
      {
        uri: `skill://${name}/references/guide.md`,
        digest: `sha256:${"1".repeat(64)}`,
        size: 4,
      },
    ],
  };
}

const catalog: RuntimeCatalog = {
  skills: [skill("zeta"), skill("alpha")],
  read(uri) {
    if (uri.endsWith("/SKILL.md")) return "instructions";
    if (uri.endsWith("/guide.md")) return "file";
    return undefined;
  },
};

describe("immutable catalog source", () => {
  it("lists complete entries in deterministic URI order", async () => {
    const source = createSkillSource(catalog, 1);
    const first = await source.list({}, context);
    expect(first.skills.map((entry) => entry.frontmatter.name)).toEqual(["alpha"]);
    expect(first.skills[0]?.resources).toHaveLength(2);
    expect(first.nextCursor).toBeTypeOf("string");

    const second = await source.list({ cursor: first.nextCursor }, context);
    expect(second.skills.map((entry) => entry.frontmatter.name)).toEqual(["zeta"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("looks up a skill without a prior listing", async () => {
    const source = createSkillSource(catalog);
    await expect(source.get("skill://zeta/SKILL.md", context)).resolves.toMatchObject({
      frontmatter: { name: "zeta" },
    });
    await expect(source.get("skill://missing/SKILL.md", context)).resolves.toBeUndefined();
  });

  it("reads exact catalog bytes and rejects unknown URIs", async () => {
    const source = createSkillSource(catalog);
    await expect(source.read("skill://alpha/SKILL.md", context)).resolves.toEqual({
      text: "instructions",
    });
    await expect(source.read("skill://alpha/.hidden", context)).resolves.toBeUndefined();
  });

  it("rejects malformed cursors with InvalidParams", async () => {
    const source = createSkillSource(catalog);
    await expect(source.list({ cursor: "not a cursor!" }, context)).rejects.toMatchObject({
      code: -32602,
    });
  });

  it("enforces the listing page-size bound", () => {
    expect(() => createSkillSource(catalog, 0)).toThrow(RangeError);
    expect(() => createSkillSource(catalog, 101)).toThrow(RangeError);
  });

  it("sorts without mutating the generated catalog", () => {
    const skills = [skill("beta"), skill("alpha")];
    const sorted = sortSkills(skills);
    expect(sorted.map((entry) => entry.frontmatter.name)).toEqual(["alpha", "beta"]);
    expect(skills.map((entry) => entry.frontmatter.name)).toEqual(["beta", "alpha"]);
  });
});

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.startsWith("event:")) return JSON.parse(text);
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  if (!data) throw new Error("missing SSE data line");
  return JSON.parse(data.slice(6));
}

function toolCall(handler: ReturnType<typeof createMcpRuntime>, name: string, args: unknown) {
  return handler.fetch(
    new Request("https://ega-plugin.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    })
  );
}

describe("compatibility tools", () => {
  const handler = createMcpRuntime(catalog);

  it("returns SKILL.md instructions and the complete manifest", async () => {
    const response = await toolCall(handler, "get_skill", { name: "alpha" });
    expect(response.status).toBe(200);
    const body = (await parseBody(response)) as {
      result: { content: Array<{ text: string }> };
    };
    const payload = JSON.parse(body.result.content[0]!.text) as {
      name: string;
      instructions: string;
      files: Array<{ uri: string; digest: string; size: number }>;
    };
    expect(payload.name).toBe("alpha");
    expect(payload.instructions).toBe("instructions");
    expect(payload.files.map((file) => file.uri)).toEqual([
      "skill://alpha/SKILL.md",
      "skill://alpha/references/guide.md",
    ]);
  });

  it("reads one exact file and rejects traversal and unknown skills", async () => {
    const ok = await toolCall(handler, "get_skill_file", {
      name: "alpha",
      path: "references/guide.md",
    });
    expect(ok.status).toBe(200);
    const okBody = (await parseBody(ok)) as {
      result: { content: Array<{ text: string }> };
    };
    expect(JSON.parse(okBody.result.content[0]!.text)).toMatchObject({
      uri: "skill://alpha/references/guide.md",
      text: "file",
    });

    for (const args of [
      { name: "alpha", path: "../SKILL.md" },
      { name: "missing", path: "references/guide.md" },
      { name: "alpha", path: "unlisted.md" },
    ]) {
      const response = await toolCall(handler, "get_skill_file", args);
      const body = (await parseBody(response)) as { result: { isError?: boolean } };
      expect(body.result.isError).toBe(true);
    }
  });

  it("searches bounded metadata without returning file bodies", async () => {
    const response = await toolCall(handler, "search_skills", { query: "alpha", limit: 1 });
    expect(response.status).toBe(200);
    const body = (await parseBody(response)) as {
      result: { content: Array<{ text: string }> };
    };
    const payload = JSON.parse(body.result.content[0]!.text) as {
      skills: Array<Record<string, unknown>>;
    };
    expect(payload.skills).toEqual([
      {
        uri: "skill://alpha/SKILL.md",
        name: "alpha",
        description: "alpha description",
      },
    ]);
  });
});
