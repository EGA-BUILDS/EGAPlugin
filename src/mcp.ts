import { createMcpHandler, McpServer, type McpHttpHandler } from "@modelcontextprotocol/server";
import {
  SkillsExtension,
  type Skill,
  type SkillResourceEntry,
} from "@modelcontextprotocol/server/ext/skills";
import { z } from "zod";
import {
  DEFAULT_PAGE_SIZE,
  SKILL_URI_PREFIX,
  createSkillSource,
  sortSkills,
  type RuntimeCatalog,
} from "./catalog";

export const SERVICE_NAME = "ega-plugin";
export const SERVICE_VERSION = "0.1.0";

const MAX_SEARCH_QUERY = 120;
const MAX_SEARCH_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SKILL_NAME = 64;
const MAX_SKILL_PATH = 300;

export interface McpRuntimeOptions {
  serverName?: string;
  serverVersion?: string;
  pageSize?: number;
}

const searchSchema = z.object({
  query: z.string().max(MAX_SEARCH_QUERY).optional(),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
});

const getSkillSchema = z.object({
  name: z.string().min(1).max(MAX_SKILL_NAME),
});

const getSkillFileSchema = z.object({
  name: z.string().min(1).max(MAX_SKILL_NAME),
  path: z.string().min(1).max(MAX_SKILL_PATH),
});

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return { isError: true, ...textResult(message) };
}

function staticManifest(skill: Skill): SkillResourceEntry[] | null {
  return skill.resources === "dynamic" ? null : skill.resources;
}

function isSafeSkillPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_SKILL_PATH) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("//")) return false;
  for (const character of path) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Builds the stateless MCP runtime. A fresh `McpServer` is created for every MCP
 * request; the immutable catalog and the Skills extension are created once.
 */
export function createMcpRuntime(
  catalog: RuntimeCatalog,
  options: McpRuntimeOptions = {}
): McpHttpHandler {
  const skills = sortSkills(catalog.skills);
  const extension = new SkillsExtension({
    source: createSkillSource(catalog, options.pageSize ?? DEFAULT_PAGE_SIZE),
    cacheHint: { ttlMs: 0, cacheScope: "private" },
  });

  return createMcpHandler(() => {
    const server = new McpServer({
      name: options.serverName ?? SERVICE_NAME,
      version: options.serverVersion ?? SERVICE_VERSION,
    });

    extension.attach(server);

    server.registerTool(
      "search_skills",
      {
        description:
          "Read-only compatibility tool. Search approved skills by name or description. " +
          "Returns bounded metadata only; it does not activate a skill.",
        inputSchema: searchSchema,
      },
      async ({ query, limit }) => {
        const needle = (query ?? "").toLowerCase();
        const matches = skills
          .filter(
            (skill) =>
              needle.length === 0 ||
              skill.frontmatter.name.toLowerCase().includes(needle) ||
              skill.frontmatter.description.toLowerCase().includes(needle)
          )
          .slice(0, limit ?? DEFAULT_SEARCH_LIMIT)
          .map((skill) => ({
            uri: skill.uri,
            name: skill.frontmatter.name,
            description: skill.frontmatter.description,
          }));
        return textResult(JSON.stringify({ skills: matches }));
      }
    );

    server.registerTool(
      "get_skill",
      {
        description:
          "Read-only compatibility tool. Read one approved SKILL.md and its complete " +
          "static manifest. It does not activate a skill.",
        inputSchema: getSkillSchema,
      },
      async ({ name }) => {
        const skill = skills.find((candidate) => candidate.frontmatter.name === name);
        const manifest = skill ? staticManifest(skill) : null;
        const instructions = skill ? catalog.read(skill.uri) : undefined;
        if (!skill || manifest === null || instructions === undefined) {
          return errorResult("Skill not found.");
        }
        const text =
          typeof instructions === "string"
            ? instructions
            : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(instructions);
        return textResult(
          JSON.stringify({
            name: skill.frontmatter.name,
            uri: skill.uri,
            instructions: text,
            files: manifest.map(({ uri, digest, size }) => ({ uri, digest, size })),
          })
        );
      }
    );

    server.registerTool(
      "get_skill_file",
      {
        description:
          "Read-only compatibility tool. Read one exact supporting file from an approved " +
          "skill. It does not activate a skill.",
        inputSchema: getSkillFileSchema,
      },
      async ({ name, path }) => {
        if (!isSafeSkillPath(path)) return errorResult("Invalid file path.");
        const skill = skills.find((candidate) => candidate.frontmatter.name === name);
        const manifest = skill ? staticManifest(skill) : null;
        if (!skill || manifest === null) return errorResult("Skill not found.");

        const decodedUri = `${SKILL_URI_PREFIX}${name}/${path}`;
        const resource = manifest.find(
          (candidate) => decodeURIComponent(candidate.uri) === decodedUri
        );
        if (!resource) return errorResult("File not found.");

        const { uri } = resource;
        const content = catalog.read(uri);
        if (content === undefined) return errorResult("File not found.");
        const text =
          typeof content === "string"
            ? content
            : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
        return textResult(
          JSON.stringify({ uri, text, digest: resource.digest, size: resource.size })
        );
      }
    );

    return server;
  });
}
