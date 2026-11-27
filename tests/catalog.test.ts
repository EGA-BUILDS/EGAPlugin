import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCatalog,
  CatalogBuildError,
  renderCatalogModule,
  sha256Digest,
  verifyThreeWayIntegrity,
  type Catalog,
  type ObservedCatalog,
} from "../scripts/build-skills";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL_SKILLS = path.join(REPO_ROOT, "skills");
const ENCODER = new TextEncoder();
const TEMP_DIRS: string[] = [];

afterEach(async () => {
  await Promise.all(
    TEMP_DIRS.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function manifest(name: string, description = `Fixture skill ${name}.`): string {
  return `---\nname: ${name}\ndescription: ${description}\nlicense: MIT\n---\n\n# ${name}\n`;
}

async function tempSkills(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "egaplugin-catalog-"));
  TEMP_DIRS.push(directory);
  return directory;
}

async function writeTree(root: string, id: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, id, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
}

async function validTree(): Promise<string> {
  const root = await tempSkills();
  await writeTree(root, "alpha", {
    "SKILL.md": manifest("alpha"),
    "references/guide.md": "guide\n",
    "assets/example.txt": "example\n",
  });
  return root;
}

function observe(catalog: Catalog): ObservedCatalog {
  return {
    skills: catalog.skills,
    resources: Object.entries(catalog.files).map(([uri, text]) => ({
      uri,
      bytes: ENCODER.encode(text),
    })),
    registeredResourceUris: Object.keys(catalog.files),
  };
}

async function baseline(): Promise<{ root: string; catalog: Catalog; observed: ObservedCatalog }> {
  const root = await validTree();
  const catalog = await buildCatalog({ skillsDir: root });
  return { root, catalog, observed: observe(catalog) };
}

async function expectBuildFailure(root: string, pattern: RegExp): Promise<void> {
  await expect(buildCatalog({ skillsDir: root })).rejects.toBeInstanceOf(CatalogBuildError);
  await expect(buildCatalog({ skillsDir: root })).rejects.toThrow(pattern);
}

describe("canonical fixture catalog", () => {
  it("builds the complete approved catalog deterministically", async () => {
    const first = await buildCatalog({ skillsDir: CANONICAL_SKILLS });
    const second = await buildCatalog({ skillsDir: CANONICAL_SKILLS });

    expect(second).toEqual(first);
    expect(renderCatalogModule(second)).toBe(renderCatalogModule(first));
    expect(first.skills).toHaveLength(7);
    expect(first.skills.map((skill) => skill.frontmatter.name)).toEqual([
      "fixture-code-review",
      "fixture-data-analysis",
      "fixture-getting-started",
      "fixture-nested-paths",
      "fixture-release-notes",
      "fixture-single-file",
      "fixture-unicode-notes",
    ]);
    expect(Object.keys(first.files)).toHaveLength(19);
    expect(first.digest).toMatch(/^sha256:[\da-f]{64}$/);
    expect(first.totalBytes).toBeGreaterThan(0);
  });

  it("includes every approved file exactly once with exact size and digest", async () => {
    const catalog = await buildCatalog({ skillsDir: CANONICAL_SKILLS });
    const seen = new Set<string>();
    for (const skill of catalog.skills) {
      expect(skill.uri).toBe(`skill://${skill.frontmatter.name}/SKILL.md`);
      expect(skill.resources[0]?.uri).toBe(skill.uri);
      for (const resource of skill.resources) {
        expect(seen.has(resource.uri)).toBe(false);
        seen.add(resource.uri);
        const text = catalog.files[resource.uri];
        expect(text).toBeTypeOf("string");
        const bytes = ENCODER.encode(text);
        expect(bytes.byteLength).toBe(resource.size);
        expect(sha256Digest(bytes)).toBe(resource.digest);
        expect(resource.uri).toMatch(/^skill:\/\/[a-z0-9-]+\//);
        expect(resource.uri).not.toMatch(/[?#]/);
      }
    }
    expect(seen.size).toBe(Object.keys(catalog.files).length);
    expect([...seen].sort()).toEqual(Object.keys(catalog.files));
  });

  it("preserves UTF-8 resource paths without normalization", async () => {
    const catalog = await buildCatalog({ skillsDir: CANONICAL_SKILLS });
    const unicode = catalog.skills.find(
      (skill) => skill.frontmatter.name === "fixture-unicode-notes"
    );
    expect(unicode).toBeDefined();
    expect(unicode?.resources.map((resource) => resource.uri)).toContain(
      "skill://fixture-unicode-notes/references/%C3%BCberblick.md"
    );
    expect(unicode?.resources.map((resource) => resource.uri)).toContain(
      "skill://fixture-unicode-notes/assets/%E6%95%B0%E6%8D%AE.txt"
    );
    expect(catalog.files["skill://fixture-unicode-notes/references/%C3%BCberblick.md"]).toContain(
      "café"
    );
  });
});

describe("generated module", () => {
  it("is a stable data-only rendering", async () => {
    const catalog = await buildCatalog({ skillsDir: CANONICAL_SKILLS });
    const rendered = renderCatalogModule(catalog);

    expect(rendered).toContain(
      `export const CATALOG_DIGEST = ${JSON.stringify(catalog.digest)} as const;`
    );
    expect(rendered).toContain("export const SKILLS =");
    expect(rendered).toContain("export const SKILL_FILES");
    expect(rendered).toContain("export const CATALOG =");
    expect(rendered).not.toContain("Date");
    expect(renderCatalogModule(await buildCatalog({ skillsDir: CANONICAL_SKILLS }))).toBe(rendered);
  });
});

describe("three-way catalog integrity", () => {
  it("accepts exact agreement between canonical files, catalog and MCP observations", async () => {
    const catalog = await buildCatalog({ skillsDir: CANONICAL_SKILLS });
    const report = await verifyThreeWayIntegrity({
      skillsDir: CANONICAL_SKILLS,
      catalog,
      observed: observe(catalog),
    });

    expect(report).toEqual({
      ok: true,
      issues: [],
      checked: { skills: 7, resources: 19, bytes: catalog.totalBytes },
    });
  });

  it("fails when an observed skill is missing", async () => {
    const { root, catalog, observed } = await baseline();
    const report = await verifyThreeWayIntegrity({
      skillsDir: root,
      catalog,
      observed: { ...observed, skills: observed.skills.slice(1) },
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((item) => item.kind)).toContain("skill-missing");
  });

  it("fails when an observed skill is unexpected", async () => {
    const { root, catalog, observed } = await baseline();
    const extra = {
      uri: "skill://extra/SKILL.md",
      frontmatter: { name: "extra", description: "Unexpected." },
      resources: [
        { uri: "skill://extra/SKILL.md", digest: sha256Digest(ENCODER.encode("x")), size: 1 },
      ],
    };
    const report = await verifyThreeWayIntegrity({
      skillsDir: root,
      catalog,
      observed: { ...observed, skills: [...observed.skills, extra] },
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((item) => item.kind)).toContain("skill-unexpected");
  });

  it("fails when observed frontmatter differs", async () => {
    const { root, catalog, observed } = await baseline();
    const skills = observed.skills.map((skill, index) =>
      index === 0
        ? { ...skill, frontmatter: { ...skill.frontmatter, description: "Tampered description." } }
        : skill
    );
    const report = await verifyThreeWayIntegrity({
      skillsDir: root,
      catalog,
      observed: { ...observed, skills },
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((item) => item.kind)).toContain("skill-mismatch");
  });

  it("fails when an observed resource is missing", async () => {
    const { root, catalog, observed } = await baseline();
    const report = await verifyThreeWayIntegrity({
      skillsDir: root,
      catalog,
      observed: { ...observed, resources: observed.resources.slice(1) },
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((item) => item.kind)).toContain("resource-missing");
  });

  it("fails when an observed resource is unexpected", async () => {
    const { root, catalog, observed } = await baseline();
    const report = await verifyThreeWayIntegrity({
      skillsDir: root,
      catalog,
      observed: {
        ...observed,
        resources: [
          ...observed.resources,
          { uri: "skill://alpha/unapproved.txt", bytes: ENCODER.encode("no\n") },
        ],
      },
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((item) => item.kind)).toContain("resource-unexpected");
  });

  it("fails on a duplicate resource URI", async () => {
    const { root, catalog, observed } = await baseline();
    const first = observed.resources[0];
    expect(first).toBeDefined();
    const report = await verifyThreeWayIntegrity({
      skillsDir: root,
      catalog,
      observed: {
        ...observed,
        resources: first === undefined ? observed.resources : [...observed.resources, first],
      },
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((item) => item.kind)).toContain("resource-duplicate");
  });

  it("fails on a byte-size difference", async () => {
    const { root, catalog, observed } = await baseline();
    const resources = observed.resources.map((resource, index) =>
      index === 0 ? { ...resource, bytes: resource.bytes.slice(0, -1) } : resource
    );
    const report = await verifyThreeWayIntegrity({
      skillsDir: root,
      catalog,
      observed: { ...observed, resources },
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((item) => item.kind)).toContain("resource-size-mismatch");
  });

  it("fails on a digest mismatch with the same byte length", async () => {
    const { root, catalog, observed } = await baseline();
    const resources = observed.resources.map((resource, index) => {
      if (index !== 0) return resource;
      const bytes = Uint8Array.from(resource.bytes);
      const last = bytes.byteLength - 1;
      bytes[last] = (bytes[last] ?? 0) ^ 0xff;
      return { ...resource, bytes };
    });
    const report = await verifyThreeWayIntegrity({
      skillsDir: root,
      catalog,
      observed: { ...observed, resources },
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((item) => item.kind)).toContain("resource-digest-mismatch");
  });

  it("fails when the generated catalog is missing a file", async () => {
    const { root, catalog, observed } = await baseline();
    const files: Record<string, string> = { ...catalog.files };
    const [firstUri] = Object.keys(files);
    expect(firstUri).toBeDefined();
    if (firstUri !== undefined) delete files[firstUri];
    const report = await verifyThreeWayIntegrity({
      skillsDir: root,
      catalog: { ...catalog, files },
      observed,
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((item) => item.kind)).toContain("catalog-missing-file");
  });

  it("fails when the generated catalog digest is stale", async () => {
    const { root, catalog, observed } = await baseline();
    const report = await verifyThreeWayIntegrity({
      skillsDir: root,
      catalog: { ...catalog, digest: `sha256:${"0".repeat(64)}` },
      observed,
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((item) => item.kind)).toContain("catalog-digest-mismatch");
  });

  it("fails when resources/list has an extra entry", async () => {
    const { root, catalog, observed } = await baseline();
    const report = await verifyThreeWayIntegrity({
      skillsDir: root,
      catalog,
      observed: {
        ...observed,
        registeredResourceUris: [
          ...(observed.registeredResourceUris ?? []),
          "skill://alpha/unapproved.txt",
        ],
      },
    });

    expect(report.ok).toBe(false);
    expect(report.issues.map((item) => item.kind)).toContain("registered-resource-unexpected");
  });
});

describe("catalog build rejection cases", () => {
  it("rejects hidden files", async () => {
    const root = await validTree();
    await writeTree(root, "alpha", { ".hidden-note.md": "hidden\n" });
    await expectBuildFailure(root, /hidden/);
  });

  it("rejects hidden directories", async () => {
    const root = await validTree();
    await writeTree(root, "alpha", { ".git/config": "hidden\n" });
    await expectBuildFailure(root, /hidden/);
  });

  it("rejects symbolic-link files", async () => {
    const root = await validTree();
    await symlink(
      path.join(root, "alpha", "SKILL.md"),
      path.join(root, "alpha", "manifest-link.md")
    );
    await expectBuildFailure(root, /symbolic links/);
  });

  it("rejects symbolic-link directories", async () => {
    const root = await validTree();
    await symlink(path.join(root, "alpha", "references"), path.join(root, "alpha", "linked"));
    await expectBuildFailure(root, /symbolic links/);
  });

  it("rejects malformed frontmatter without a closing line", async () => {
    const root = await validTree();
    await writeFile(
      path.join(root, "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: x\n",
      "utf8"
    );
    await expectBuildFailure(root, /closing/);
  });

  it("rejects frontmatter without a description", async () => {
    const root = await validTree();
    await writeFile(path.join(root, "alpha", "SKILL.md"), "---\nname: alpha\n---\n", "utf8");
    await expectBuildFailure(root, /description/);
  });

  it("rejects duplicate frontmatter keys", async () => {
    const root = await validTree();
    await writeFile(
      path.join(root, "alpha", "SKILL.md"),
      "---\nname: alpha\nname: alpha\ndescription: x\n---\n",
      "utf8"
    );
    await expectBuildFailure(root, /duplicate key/);
  });

  it("rejects nested metadata maps instead of guessing", async () => {
    const root = await validTree();
    await writeFile(
      path.join(root, "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: x\nmetadata:\n  owner: test\n---\n",
      "utf8"
    );
    await expectBuildFailure(root, /metadata maps/);
  });

  it("rejects indented YAML instead of guessing", async () => {
    const root = await validTree();
    await writeFile(
      path.join(root, "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: x\nowner: test\n  team: test\n---\n",
      "utf8"
    );
    await expectBuildFailure(root, /nested YAML/);
  });

  it("rejects a frontmatter name that does not match the folder", async () => {
    const root = await validTree();
    await writeFile(path.join(root, "alpha", "SKILL.md"), manifest("other"), "utf8");
    await expectBuildFailure(root, /must match folder/);
  });

  it("rejects an invalid skill folder name", async () => {
    const root = await validTree();
    await writeTree(root, "Bad_Name", { "SKILL.md": manifest("Bad_Name") });
    await expectBuildFailure(root, /folder name/);
  });

  it("rejects path separators inside a file name", async () => {
    const root = await validTree();
    await writeTree(root, "alpha", { "references/bad\\name.md": "bad\n" });
    await expectBuildFailure(root, /path separators/);
  });

  it("rejects invalid UTF-8", async () => {
    const root = await validTree();
    await writeFile(path.join(root, "alpha", "assets", "binary.bin"), Buffer.from([0xff, 0xfe]));
    await expectBuildFailure(root, /UTF-8/);
  });

  it("rejects NUL bytes", async () => {
    const root = await validTree();
    await writeTree(root, "alpha", { "assets/nul.txt": "before\u0000after" });
    await expectBuildFailure(root, /NUL/);
  });

  it("rejects files over the configured size limit", async () => {
    const root = await validTree();
    await writeTree(root, "alpha", { "assets/large.txt": "x".repeat(1025) });
    await expect(buildCatalog({ skillsDir: root, limits: { fileBytes: 1024 } })).rejects.toThrow(
      /limit is 1024/
    );
  });

  it("rejects a skill without SKILL.md", async () => {
    const root = await validTree();
    await writeTree(root, "beta", { "references/only.md": "only\n" });
    await expectBuildFailure(root, /missing SKILL.md/);
  });

  it("rejects a non-directory entry at the skills root", async () => {
    const root = await validTree();
    await writeFile(path.join(root, "README.md"), "not a skill\n", "utf8");
    await expectBuildFailure(root, /only skill folders/);
  });

  it("rejects an empty skills directory", async () => {
    const root = await tempSkills();
    await expectBuildFailure(root, /no approved skills/);
  });

  it("reports a missing skills directory", async () => {
    const root = path.join(await tempSkills(), "missing");
    await expectBuildFailure(root, /directory not found/);
  });
});
