/**
 * Deterministic build of the approved skill catalog.
 *
 * Reads every approved skill below `skills/`, validates the file tree and
 * `SKILL.md` frontmatter, and renders `generated/skills.ts`. The generated
 * module contains only data: the sorted skill entries, the exact UTF-8 file
 * contents, and a digest over the complete catalog.
 *
 * It also exports `verifyThreeWayIntegrity`, which compares:
 *
 *   1. the canonical files under `skills/`,
 *   2. the generated catalog and manifests, and
 *   3. the entries and resources observed over MCP.
 *
 * This module intentionally depends on Node built-ins only so it can run
 * before the Worker runtime dependencies are installed:
 *
 *   node scripts/build-skills.ts
 *   node scripts/build-skills.ts --check
 *   node scripts/build-skills.ts --skills <dir> --out <file>
 */

import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

export const DEFAULT_SKILLS_DIR = path.join(REPO_ROOT, "skills");
export const DEFAULT_OUTPUT_PATH = path.join(REPO_ROOT, "generated", "skills.ts");

export interface CatalogLimits {
  /** Maximum size of one approved file, in raw bytes. */
  readonly fileBytes: number;
  /** Maximum number of files in one skill, including `SKILL.md`. */
  readonly skillFiles: number;
  /** Maximum total raw bytes in one skill. */
  readonly skillBytes: number;
  /** Maximum total raw bytes across the complete catalog. */
  readonly catalogBytes: number;
}

export const DEFAULT_LIMITS: CatalogLimits = Object.freeze({
  fileBytes: 256 * 1024,
  skillFiles: 512,
  skillBytes: 16 * 1024 * 1024,
  catalogBytes: 16 * 1024 * 1024,
});

export interface CatalogResource {
  readonly uri: string;
  readonly digest: string;
  readonly size: number;
}

export type CatalogFrontmatter = Readonly<Record<string, string>> & {
  readonly name: string;
  readonly description: string;
};

export interface CatalogSkill {
  readonly uri: string;
  readonly frontmatter: CatalogFrontmatter;
  readonly resources: readonly CatalogResource[];
}

export interface Catalog {
  readonly skills: readonly CatalogSkill[];
  /** Resource URI to the exact approved UTF-8 text. */
  readonly files: Readonly<Record<string, string>>;
  /** `sha256:<lowercase hex>` over the skill entries. */
  readonly digest: string;
  readonly totalBytes: number;
}

export interface BuildOptions {
  readonly skillsDir?: string;
  readonly limits?: Partial<CatalogLimits>;
}

export class CatalogBuildError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`catalog build failed:\n- ${problems.join("\n- ")}`);
    this.name = "CatalogBuildError";
    this.problems = problems;
  }
}

const SKILL_ID_PATTERN = /^[\da-z]+(?:-[\da-z]+)*$/;
const FRONTMATTER_KEY_PATTERN = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/;
const ENCODED_IN_URI_SEGMENT = /[^\w!$&'()*+,.:;=@[\]|~-]/gu;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const TEXT_ENCODER = new TextEncoder();

function fail(where: string, message: string): never {
  throw new CatalogBuildError([`${where}: ${message}`]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function compareNames(left: Dirent, right: Dirent): number {
  return compareStrings(left.name, right.name);
}

function resolveLimits(overrides: Partial<CatalogLimits> | undefined): CatalogLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`limit ${name} must be a positive safe integer`);
    }
  }
  return limits;
}

function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
}

function validateSegment(segment: string, where: string): void {
  if (segment.length === 0) fail(where, "empty path segment");
  if (segment === "." || segment === "..") fail(where, "relative path segments are not allowed");
  if (segment.startsWith(".")) fail(where, "hidden files and directories are not allowed");
  if (segment.includes("/") || segment.includes("\\")) {
    fail(where, "path separators are not allowed inside a segment");
  }
  if (hasControlCharacter(segment)) fail(where, "control characters are not allowed");
  if (TEXT_ENCODER.encode(segment).byteLength > 255)
    fail(where, "path segment is longer than 255 bytes");
}

/**
 * Percent-encodes one URI path segment exactly as the MCP SDK does: keep
 * WHATWG path characters, encode `%`, `/`, `\`, whitespace and non-ASCII.
 */
function encodeSegment(segment: string): string {
  if (segment === "." || segment === "..") return segment.replaceAll(".", "%2E");
  return segment.replaceAll(ENCODED_IN_URI_SEGMENT, (character) => encodeURIComponent(character));
}

function skillRootUri(id: string): string {
  return `skill://${encodeURIComponent(id)}`;
}

function skillUri(id: string, relativePath: string): string {
  const encoded = relativePath.split("/").map(encodeSegment).join("/");
  return `${skillRootUri(id)}/${encoded}`;
}

export function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function countCharacters(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length;) {
    const code = text.codePointAt(index);
    index += code !== undefined && code > 0xffff ? 2 : 1;
    count++;
  }
  return count;
}

interface ScalarEntry {
  readonly key: string;
  readonly value: string;
}

function parseQuotedDouble(raw: string, where: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "string") fail(where, "double-quoted scalar must be a string");
    return parsed;
  } catch {
    return fail(where, "invalid double-quoted scalar");
  }
}

function parseQuotedSingle(raw: string, where: string): string {
  if (!raw.endsWith("'")) fail(where, "unterminated single-quoted scalar");
  return raw.slice(1, -1).replaceAll("''", "'");
}

function parseScalar(raw: string, where: string): string {
  const value = raw.trim();
  if (value.length === 0 || value.startsWith("#")) fail(where, "missing scalar value");
  const first = value[0]!;
  if (first === '"') return parseQuotedDouble(value, where);
  if (first === "'") return parseQuotedSingle(value, where);
  if (first === "[" || first === "{" || first === "|" || first === ">") {
    fail(where, "flow collections and block scalars are not supported by the fixture builder");
  }
  if ("&*!%@`,]}".includes(first)) {
    fail(where, `"${first}" cannot start an unquoted scalar; quote the value`);
  }
  if (/^\?(?:[\t ]|$)/u.test(value)) fail(where, "complex keys are not supported");
  return value.replace(/[ \t]+#.*$/u, "").trim();
}

/**
 * Parses the small YAML subset used by approved fixture skills: one top-level
 * mapping of scalar values. Nested mappings, sequences, anchors, aliases,
 * tags and block scalars fail closed instead of being interpreted differently
 * from a full YAML parser.
 */
export function parseFrontmatter(markdown: string): CatalogFrontmatter {
  let text = markdown.replaceAll("\r\n", "\n");
  if (text.codePointAt(0) === 0xfeff) text = text.slice(1);
  if (!text.startsWith("---\n")) fail("SKILL.md", 'must begin with a "---" line');

  const rest = text.slice(4);
  const close = /^---[\t ]*$/mu.exec(rest);
  if (close === null) fail("SKILL.md", 'frontmatter has no closing "---" line');

  const yaml = rest.slice(0, close.index);
  const entries: ScalarEntry[] = [];
  const seen = new Set<string>();
  const lines = yaml.split("\n");
  if (lines.at(-1) === "") lines.pop();

  for (const [index, raw] of lines.entries()) {
    const lineNumber = index + 2;
    const where = `SKILL.md frontmatter line ${lineNumber}`;
    if (/^[ \t]/u.test(raw)) {
      fail(where, "nested YAML is not supported by the fixture builder");
    }
    const line = raw.trimEnd();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = FRONTMATTER_KEY_PATTERN.exec(line);
    if (match === null) fail(where, 'expected "key: value"');
    const key = match[1]!;
    if (seen.has(key)) fail(where, `duplicate key "${key}"`);
    seen.add(key);
    if (key === "metadata") {
      fail(where, "metadata maps are not supported by the fixture builder");
    }
    entries.push({ key, value: parseScalar(match[2] ?? "", where) });
  }

  const fields: Record<string, string> = {};
  for (const entry of entries) fields[entry.key] = entry.value;
  const name = fields["name"];
  const description = fields["description"];
  if (name === undefined) fail("SKILL.md frontmatter", 'missing string "name"');
  if (description === undefined) fail("SKILL.md frontmatter", 'missing string "description"');
  return { ...fields, name, description };
}

function validateFrontmatter(id: string, frontmatter: CatalogFrontmatter): void {
  const { name, description } = frontmatter;
  if (name.length === 0 || name.length > 64 || !SKILL_ID_PATTERN.test(name)) {
    fail(
      `${id}/SKILL.md`,
      'frontmatter "name" must be 1-64 lowercase letters, digits and single hyphens'
    );
  }
  if (name !== id) fail(`${id}/SKILL.md`, `frontmatter name "${name}" must match folder "${id}"`);
  const descriptionLength = countCharacters(description);
  if (descriptionLength === 0 || descriptionLength > 1024) {
    fail(`${id}/SKILL.md`, 'frontmatter "description" must be 1-1024 characters');
  }
  const compatibility = frontmatter["compatibility"];
  if (compatibility !== undefined) {
    const length = countCharacters(compatibility);
    if (length === 0 || length > 500) {
      fail(`${id}/SKILL.md`, 'frontmatter "compatibility" must be 1-500 characters');
    }
  }
}

interface CollectedFile {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly text: string;
}

async function collectSkillFiles(id: string, root: string): Promise<CollectedFile[]> {
  const files: CollectedFile[] = [];

  async function walk(directory: string, relativeParts: readonly string[]): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(compareNames);
    for (const entry of entries) {
      const parts = [...relativeParts, entry.name];
      const relativePath = parts.join("/");
      const where = `${id}/${relativePath}`;
      validateSegment(entry.name, where);
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(where, "symbolic links are not allowed");
      if (entry.isDirectory()) {
        await walk(fullPath, parts);
        continue;
      }
      if (!entry.isFile()) fail(where, "only regular files and directories are allowed");
      const bytes = new Uint8Array(await readFile(fullPath));
      let text: string;
      try {
        text = TEXT_DECODER.decode(bytes);
      } catch {
        fail(where, "file is not valid UTF-8");
      }
      if (text.includes("\u0000")) fail(where, "NUL bytes are not allowed");
      files.push({ relativePath, bytes, text });
    }
  }

  await walk(root, []);
  return files;
}

async function buildSkill(
  id: string,
  root: string,
  limits: CatalogLimits
): Promise<{ skill: CatalogSkill; files: Record<string, string>; bytes: number }> {
  if (id.length > 64 || !SKILL_ID_PATTERN.test(id)) {
    fail(`skills/${id}`, "folder name must be 1-64 lowercase letters, digits and single hyphens");
  }

  const collected = await collectSkillFiles(id, root);
  const manifest = collected.find((file) => file.relativePath === "SKILL.md");
  if (manifest === undefined) fail(`${id}/SKILL.md`, "missing SKILL.md");
  if (collected.length > limits.skillFiles) {
    fail(id, `skill has ${collected.length} files; limit is ${limits.skillFiles}`);
  }

  const frontmatter = parseFrontmatter(manifest.text);
  validateFrontmatter(id, frontmatter);

  const resources: CatalogResource[] = [];
  const files: Record<string, string> = {};
  let bytes = 0;
  for (const file of collected) {
    if (file.bytes.byteLength > limits.fileBytes) {
      fail(
        `${id}/${file.relativePath}`,
        `file is ${file.bytes.byteLength} bytes; limit is ${limits.fileBytes}`
      );
    }
    bytes += file.bytes.byteLength;
    const uri = skillUri(id, file.relativePath);
    if (Object.hasOwn(files, uri))
      fail(`${id}/${file.relativePath}`, `duplicate resource URI ${uri}`);
    files[uri] = file.text;
    resources.push({ uri, digest: sha256Digest(file.bytes), size: file.bytes.byteLength });
  }
  if (bytes > limits.skillBytes) fail(id, `skill is ${bytes} bytes; limit is ${limits.skillBytes}`);
  resources.sort((left, right) => compareStrings(left.uri, right.uri));

  return {
    skill: { uri: skillUri(id, "SKILL.md"), frontmatter, resources },
    files,
    bytes,
  };
}

/**
 * Builds the complete immutable catalog from the canonical file tree.
 * Skill entries and resource URIs are sorted by code unit; the output depends
 * only on the approved bytes.
 */
export async function buildCatalog(options: BuildOptions = {}): Promise<Catalog> {
  const skillsDir = path.resolve(options.skillsDir ?? DEFAULT_SKILLS_DIR);
  const limits = resolveLimits(options.limits);
  let rootEntries: Dirent[];
  try {
    rootEntries = await readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") fail("skills", `directory not found: ${skillsDir}`);
    throw error;
  }

  const skills: CatalogSkill[] = [];
  const files: Record<string, string> = {};
  let totalBytes = 0;

  for (const entry of rootEntries.sort(compareNames)) {
    validateSegment(entry.name, `skills/${entry.name}`);
    if (entry.isSymbolicLink()) fail(`skills/${entry.name}`, "symbolic links are not allowed");
    if (!entry.isDirectory())
      fail(`skills/${entry.name}`, "only skill folders are allowed at this level");
    const built = await buildSkill(entry.name, path.join(skillsDir, entry.name), limits);
    skills.push(built.skill);
    for (const [uri, text] of Object.entries(built.files)) {
      if (Object.hasOwn(files, uri)) fail(uri, "duplicate resource URI across skills");
      files[uri] = text;
    }
    totalBytes += built.bytes;
  }

  if (skills.length === 0) fail("skills", "no approved skills found");
  if (totalBytes > limits.catalogBytes) {
    fail("skills", `catalog is ${totalBytes} bytes; limit is ${limits.catalogBytes}`);
  }
  skills.sort((left, right) => compareStrings(left.uri, right.uri));

  return {
    skills,
    files: Object.fromEntries(
      Object.entries(files).sort(([left], [right]) => compareStrings(left, right))
    ),
    digest: sha256Digest(TEXT_ENCODER.encode(JSON.stringify(skills))),
    totalBytes,
  };
}

/** Renders the deterministic TypeScript module consumed by the Worker. */
export function renderCatalogModule(catalog: Catalog): string {
  const resourceCount = catalog.skills.reduce((count, skill) => count + skill.resources.length, 0);
  const skillsJson = JSON.stringify(catalog.skills, null, 2);
  const filesJson = JSON.stringify(catalog.files, null, 2);
  return `// @generated by scripts/build-skills.ts. Do not edit by hand.
// ${catalog.skills.length} skills, ${resourceCount} resources, ${catalog.totalBytes} raw bytes.

export interface CatalogResource {
  readonly uri: string;
  readonly digest: string;
  readonly size: number;
}

export type CatalogFrontmatter = Readonly<Record<string, string>> & {
  readonly name: string;
  readonly description: string;
};

export interface CatalogSkill {
  readonly uri: string;
  readonly frontmatter: CatalogFrontmatter;
  readonly resources: readonly CatalogResource[];
}

export const CATALOG_DIGEST = ${JSON.stringify(catalog.digest)} as const;

export const SKILLS = ${skillsJson} as const satisfies readonly CatalogSkill[];

export const SKILL_FILES: Readonly<Record<string, string>> = ${filesJson};

export const CATALOG = {
  digest: CATALOG_DIGEST,
  skills: SKILLS,
  files: SKILL_FILES,
} as const;
`;
}

export interface IntegrityIssue {
  readonly kind:
    | "catalog-digest-mismatch"
    | "catalog-missing-file"
    | "catalog-unexpected-file"
    | "catalog-content-mismatch"
    | "skill-missing"
    | "skill-unexpected"
    | "skill-duplicate"
    | "skill-mismatch"
    | "skill-order"
    | "resource-missing"
    | "resource-unexpected"
    | "resource-duplicate"
    | "resource-order"
    | "resource-size-mismatch"
    | "resource-digest-mismatch"
    | "resource-content-mismatch"
    | "registered-resource-missing"
    | "registered-resource-unexpected"
    | "registered-resource-duplicate";
  readonly uri?: string;
  readonly message: string;
}

export interface IntegrityReport {
  readonly ok: boolean;
  readonly issues: readonly IntegrityIssue[];
  readonly checked: {
    readonly skills: number;
    readonly resources: number;
    readonly bytes: number;
  };
}

export interface ObservedResource {
  readonly uri: string;
  readonly bytes: Uint8Array;
}

/**
 * The catalog as an MCP client observed it: every `skills/list` page merged,
 * every manifest resource read, and optionally the full `resources/list`
 * inventory. Protocol tests build this from the pinned SDK client.
 */
export interface ObservedCatalog {
  readonly skills: readonly CatalogSkill[];
  readonly resources: readonly ObservedResource[];
  readonly registeredResourceUris?: readonly string[];
}

function issue(
  issues: IntegrityIssue[],
  kind: IntegrityIssue["kind"],
  message: string,
  uri?: string
): void {
  issues.push(uri === undefined ? { kind, message } : { kind, uri, message });
}

function sameFrontmatter(left: CatalogFrontmatter, right: CatalogFrontmatter): boolean {
  const leftKeys = Object.keys(left).sort(compareStrings);
  const rightKeys = Object.keys(right).sort(compareStrings);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function resourceMap(
  resources: readonly CatalogResource[],
  label: string,
  issues: IntegrityIssue[]
): Map<string, CatalogResource> {
  const map = new Map<string, CatalogResource>();
  for (const resource of resources) {
    if (map.has(resource.uri)) {
      issue(
        issues,
        "resource-duplicate",
        `${label} lists ${resource.uri} more than once`,
        resource.uri
      );
      continue;
    }
    map.set(resource.uri, resource);
  }
  return map;
}

function compareSkillEntries(
  expected: readonly CatalogSkill[],
  actual: readonly CatalogSkill[],
  label: string,
  issues: IntegrityIssue[]
): void {
  const expectedMap = new Map(expected.map((skill) => [skill.uri, skill]));
  const actualMap = new Map<string, CatalogSkill>();
  for (const skill of actual) {
    if (actualMap.has(skill.uri)) {
      issue(issues, "skill-duplicate", `${label} lists ${skill.uri} more than once`, skill.uri);
      continue;
    }
    actualMap.set(skill.uri, skill);
  }
  for (const expectedSkill of expected) {
    const actualSkill = actualMap.get(expectedSkill.uri);
    if (actualSkill === undefined) {
      issue(issues, "skill-missing", `${label} is missing ${expectedSkill.uri}`, expectedSkill.uri);
      continue;
    }
    if (!sameFrontmatter(expectedSkill.frontmatter, actualSkill.frontmatter)) {
      issue(
        issues,
        "skill-mismatch",
        `${label} frontmatter differs for ${expectedSkill.uri}`,
        expectedSkill.uri
      );
    }
    const expectedResources = resourceMap(expectedSkill.resources, label, []);
    const actualResources = resourceMap(actualSkill.resources, label, issues);
    for (const [uri, expectedResource] of expectedResources) {
      const actualResource = actualResources.get(uri);
      if (actualResource === undefined) {
        issue(issues, "resource-missing", `${label} manifest is missing ${uri}`, uri);
        continue;
      }
      if (actualResource.size !== expectedResource.size) {
        issue(
          issues,
          "resource-size-mismatch",
          `${label} size for ${uri} is ${actualResource.size}; expected ${expectedResource.size}`,
          uri
        );
      }
      if (actualResource.digest !== expectedResource.digest) {
        issue(issues, "resource-digest-mismatch", `${label} digest differs for ${uri}`, uri);
      }
    }
    for (const uri of actualResources.keys()) {
      if (!expectedResources.has(uri)) {
        issue(issues, "resource-unexpected", `${label} manifest has unexpected ${uri}`, uri);
      }
    }
    const actualResourceUris = actualSkill.resources.map((resource) => resource.uri);
    const sortedResourceUris = [...actualResourceUris].sort(compareStrings);
    if (actualResourceUris.some((uri, index) => uri !== sortedResourceUris[index])) {
      issue(
        issues,
        "resource-order",
        `${label} manifest for ${actualSkill.uri} is not in deterministic URI order`,
        actualSkill.uri
      );
    }
  }
  for (const uri of actualMap.keys()) {
    if (!expectedMap.has(uri)) {
      issue(issues, "skill-unexpected", `${label} has unexpected ${uri}`, uri);
    }
  }
  const actualUris = actual.map((skill) => skill.uri);
  const sortedUris = [...actualUris].sort(compareStrings);
  if (actualUris.some((uri, index) => uri !== sortedUris[index])) {
    issue(issues, "skill-order", `${label} skill entries are not in deterministic URI order`);
  }
}

function compareCatalog(expected: Catalog, actual: Catalog, issues: IntegrityIssue[]): void {
  if (actual.digest !== expected.digest) {
    issue(
      issues,
      "catalog-digest-mismatch",
      "generated catalog digest differs from the canonical build"
    );
  }
  compareSkillEntries(expected.skills, actual.skills, "generated catalog", issues);
  for (const [uri, bytes] of Object.entries(expected.files)) {
    const actualBytes = actual.files[uri];
    if (actualBytes === undefined) {
      issue(issues, "catalog-missing-file", `generated catalog is missing ${uri}`, uri);
      continue;
    }
    if (actualBytes !== bytes) {
      issue(
        issues,
        "catalog-content-mismatch",
        `generated catalog content differs for ${uri}`,
        uri
      );
    }
  }
  for (const uri of Object.keys(actual.files)) {
    if (!Object.hasOwn(expected.files, uri)) {
      issue(issues, "catalog-unexpected-file", `generated catalog has unexpected ${uri}`, uri);
    }
  }
}

function compareObservedResources(
  manifest: readonly CatalogResource[],
  observed: readonly ObservedResource[],
  expectedFiles: Readonly<Record<string, string>>,
  issues: IntegrityIssue[]
): void {
  const expected = new Map(manifest.map((resource) => [resource.uri, resource]));
  const actual = new Map<string, Uint8Array>();
  for (const resource of observed) {
    if (actual.has(resource.uri)) {
      issue(
        issues,
        "resource-duplicate",
        `MCP observed ${resource.uri} more than once`,
        resource.uri
      );
      continue;
    }
    actual.set(resource.uri, resource.bytes);
  }
  for (const [uri, expectedResource] of expected) {
    const bytes = actual.get(uri);
    if (bytes === undefined) {
      issue(issues, "resource-missing", `MCP did not expose ${uri}`, uri);
      continue;
    }
    if (bytes.byteLength !== expectedResource.size) {
      issue(
        issues,
        "resource-size-mismatch",
        `MCP returned ${bytes.byteLength} bytes for ${uri}; expected ${expectedResource.size}`,
        uri
      );
    }
    if (sha256Digest(bytes) !== expectedResource.digest) {
      issue(issues, "resource-digest-mismatch", `MCP bytes digest differs for ${uri}`, uri);
    }
    const canonical = expectedFiles[uri];
    if (canonical === undefined || !bytesEqual(TEXT_ENCODER.encode(canonical), bytes)) {
      issue(
        issues,
        "resource-content-mismatch",
        `MCP content differs from the canonical file for ${uri}`,
        uri
      );
    }
  }
  for (const uri of actual.keys()) {
    if (!expected.has(uri)) {
      issue(issues, "resource-unexpected", `MCP exposed unexpected ${uri}`, uri);
    }
  }
}

function compareRegisteredResources(
  manifest: readonly CatalogResource[],
  registered: readonly string[],
  issues: IntegrityIssue[]
): void {
  const expected = new Set(manifest.map((resource) => resource.uri));
  const actual = new Set<string>();
  for (const uri of registered) {
    if (actual.has(uri)) {
      issue(
        issues,
        "registered-resource-duplicate",
        `resources/list lists ${uri} more than once`,
        uri
      );
      continue;
    }
    actual.add(uri);
  }
  for (const uri of expected) {
    if (!actual.has(uri))
      issue(issues, "registered-resource-missing", `resources/list is missing ${uri}`, uri);
  }
  for (const uri of actual) {
    if (!expected.has(uri)) {
      issue(issues, "registered-resource-unexpected", `resources/list has unexpected ${uri}`, uri);
    }
  }
}

/**
 * Three-way integrity check required by SPEC-001 §12.
 *
 * Pass the generated catalog and the observations from a real MCP client.
 * The canonical files are re-read and re-hashed here, so a stale or tampered
 * generated module cannot agree with itself.
 */
export async function verifyThreeWayIntegrity(input: {
  readonly catalog: Catalog;
  readonly observed: ObservedCatalog;
  readonly skillsDir?: string;
}): Promise<IntegrityReport> {
  const expected = await buildCatalog({ skillsDir: input.skillsDir });
  const issues: IntegrityIssue[] = [];
  compareCatalog(expected, input.catalog, issues);
  compareSkillEntries(expected.skills, input.observed.skills, "MCP", issues);

  const manifest = expected.skills.flatMap((skill) => skill.resources);
  const resources = new Map(manifest.map((resource) => [resource.uri, resource]));
  compareObservedResources(
    [...resources.values()],
    input.observed.resources,
    expected.files,
    issues
  );
  if (input.observed.registeredResourceUris !== undefined) {
    compareRegisteredResources(manifest, input.observed.registeredResourceUris, issues);
  }

  return {
    ok: issues.length === 0,
    issues,
    checked: {
      skills: expected.skills.length,
      resources: manifest.length,
      bytes: expected.totalBytes,
    },
  };
}

const USAGE = `Usage: node scripts/build-skills.ts [options]

Options:
  --skills <dir>  Canonical skill root (default: skills/)
  --out <file>    Generated module path (default: generated/skills.ts)
  --check         Fail if the generated module is missing or out of date
  --help          Show this message
`;

interface CliOptions {
  readonly skillsDir: string;
  readonly out: string;
  readonly check: boolean;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let skillsDir = DEFAULT_SKILLS_DIR;
  let out = DEFAULT_OUTPUT_PATH;
  let check = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      return { skillsDir, out, check, help: true };
    }
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--skills" || argument === "--out") {
      const value = argv[++index];
      if (value === undefined || value.length === 0) {
        throw new TypeError(`${argument} requires a path`);
      }
      if (argument === "--skills") skillsDir = path.resolve(value);
      else out = path.resolve(value);
      continue;
    }
    throw new TypeError(`unknown argument: ${argument}`);
  }
  return { skillsDir, out, check, help: false };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  const catalog = await buildCatalog({ skillsDir: options.skillsDir });
  const rendered = renderCatalogModule(catalog);

  if (options.check) {
    let current: string | undefined;
    try {
      current = await readFile(options.out, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    if (current !== rendered) {
      process.stderr.write(
        `generated catalog is out of date: ${options.out}\nrun: node scripts/build-skills.ts\n`
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `generated catalog is up to date (${catalog.skills.length} skills, ${catalog.totalBytes} bytes)\n`
    );
    return;
  }

  await mkdir(path.dirname(options.out), { recursive: true });
  await writeFile(options.out, rendered, "utf8");
  process.stdout.write(
    `wrote ${options.out} (${catalog.skills.length} skills, ${catalog.totalBytes} bytes, ${catalog.digest})\n`
  );
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && pathToFileURL(path.resolve(entrypoint)).href === import.meta.url) {
  main().catch((error: unknown) => {
    if (error instanceof CatalogBuildError) process.stderr.write(`${error.message}\n`);
    else
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
      );
    process.exitCode = 1;
  });
}
