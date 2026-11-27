import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { Skill, SkillReadResult, SkillSource } from "@modelcontextprotocol/server/ext/skills";

/** Every served resource URI starts with this prefix. */
export const SKILL_URI_PREFIX = "skill://";

/** Default number of complete skill entries returned per `skills/list` page. */
export const DEFAULT_PAGE_SIZE = 100;
/** Server-enforced upper bound for one listing page. */
export const MAX_PAGE_SIZE = 100;

export interface CatalogResource {
  readonly uri: string;
  readonly digest: string;
  readonly size: number;
}

/** One generated skill entry, structurally compatible with the SDK `Skill`. */
export interface CatalogSkill {
  readonly uri: string;
  readonly frontmatter: {
    readonly name: string;
    readonly description: string;
    readonly [field: string]: unknown;
  };
  readonly resources: readonly CatalogResource[];
}

export interface GeneratedCatalog {
  readonly skills: readonly CatalogSkill[];
  /** Resource URI to the exact approved UTF-8 text. */
  readonly files: Readonly<Record<string, string>>;
}

/**
 * The immutable runtime catalog contract. The catalog builder owns the generated
 * module that satisfies it; the runtime only reads it.
 *
 * `skills` holds one entry per approved skill, including its complete static file
 * manifest. `read` returns the exact approved bytes for a URI, or `undefined` when
 * the URI is not part of the catalog.
 */
export interface RuntimeCatalog {
  readonly skills: readonly Skill[];
  read(uri: string): string | Uint8Array | undefined;
}

/**
 * Adapts the catalog builder's generated `SKILLS` and `SKILL_FILES` exports to
 * the runtime contract. Entries are copied so the served manifests cannot be
 * mutated through the generated module.
 */
export function createStaticCatalog(generated: GeneratedCatalog): RuntimeCatalog {
  return {
    skills: generated.skills.map((skill) => ({
      uri: skill.uri,
      frontmatter: { ...skill.frontmatter },
      resources: skill.resources.map(({ uri, digest, size }) => ({ uri, digest, size })),
    })),
    read(uri) {
      return generated.files[uri];
    },
  };
}

const CURSOR_PREFIX = "skills:1:";

function encodeCursor(offset: number): string {
  const encoded = btoa(`${CURSOR_PREFIX}${offset}`);
  return encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string): number | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  try {
    const padded = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    if (!decoded.startsWith(CURSOR_PREFIX)) return null;
    const raw = decoded.slice(CURSOR_PREFIX.length);
    if (!/^(?:0|[1-9]\d*)$/.test(raw)) return null;
    const offset = Number(raw);
    return Number.isSafeInteger(offset) ? offset : null;
  } catch {
    return null;
  }
}

/** Deterministic catalog order, independent of build or locale. */
export function sortSkills(skills: readonly Skill[]): Skill[] {
  return [...skills].sort((left, right) =>
    left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0
  );
}

/**
 * Serves the immutable catalog through the SDK's public `SkillSource` adapter.
 * Cursors are opaque, single-use values; malformed cursors are rejected before
 * a page is produced.
 */
export function createSkillSource(
  catalog: RuntimeCatalog,
  pageSize: number = DEFAULT_PAGE_SIZE
): SkillSource {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new RangeError(`pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }

  const skills = sortSkills(catalog.skills);
  const byUri = new Map(skills.map((skill) => [skill.uri, skill]));

  return {
    async list({ cursor }) {
      const offset = cursor === undefined ? 0 : decodeCursor(cursor);
      if (offset === null) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid cursor");
      }
      const page = skills.slice(offset, offset + pageSize);
      const nextOffset = offset + pageSize;
      return nextOffset < skills.length
        ? { skills: page, nextCursor: encodeCursor(nextOffset) }
        : { skills: page };
    },
    async get(uri) {
      return byUri.get(uri);
    },
    async read(uri): Promise<SkillReadResult | undefined> {
      const content = catalog.read(uri);
      if (content === undefined) return undefined;
      return typeof content === "string" ? { text: content } : { bytes: content };
    },
  };
}
