// Test-only skill corpus used by the acceptance fixture server.
// Deliberately small, deterministic, and public. Never part of the product bundle.

import { createHash } from "node:crypto";

const decode = (value) => new TextEncoder().encode(value);
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * Canonical fixture corpus. `files` excludes a dotfile that a strict loader may
 * silently drop; the suite asserts that dotfiles never reach the wire.
 */
export const CORPUS = {
  "demo-skill": {
    "SKILL.md": [
      "---",
      "name: demo-skill",
      "description: Minimal deterministic fixture skill for protocol acceptance.",
      "license: MIT",
      "---",
      "",
      "# Demo skill",
      "",
      "Use this skill when validating the EGAPlugin MCP contract.",
      "",
    ].join("\n"),
    "references/guide.md": "# Guide\n\nRead the guide.\n",
    "assets/template.txt": "template body\n",
    ".hidden-note.md": "must never be exposed\n",
  },
  "second-skill": {
    "SKILL.md": [
      "---",
      "name: second-skill",
      "description: Second fixture skill covering pagination and lookup.",
      "license: MIT",
      "---",
      "",
      "# Second skill",
      "",
      "Body for the second fixture skill.",
      "",
    ].join("\n"),
    "references/notes.md": "notes\n",
  },
  "unicode-skill": {
    "SKILL.md": [
      "---",
      "name: unicode-skill",
      "description: Ünïcode fixture skill with non-ASCII bytes.",
      "license: MIT",
      "---",
      "",
      "# Unicode",
      "",
      "Résumé — ünïcode content.",
      "",
    ].join("\n"),
    "references/ünicode.md": "ünicode reference\n",
  },
};

/** Files that are approved for exposure (dotfiles are not). */
export function exposedFiles(skillName) {
  return Object.keys(CORPUS[skillName]).filter((path) => !path.startsWith("."));
}

/** Build the expected wire manifest independently of the server under test. */
export function expectedCatalog() {
  return Object.keys(CORPUS)
    .sort()
    .map((name) => {
      const files = exposedFiles(name).sort();
      return {
        name,
        uri: `skill://${name}/SKILL.md`,
        files: files.map((path) => {
          const bytes = decode(CORPUS[name][path]);
          return {
            path,
            uri: `skill://${name}/${path}`,
            size: bytes.byteLength,
            digest: sha256(bytes),
          };
        }),
      };
    });
}

/** Raw bytes for one approved file, or undefined when not approved. */
export function readApprovedFile(skillName, path) {
  if (!Object.hasOwn(CORPUS, skillName)) return undefined;
  if (!exposedFiles(skillName).includes(path)) return undefined;
  return decode(CORPUS[skillName][path]);
}

/** Parse the fixture frontmatter without a YAML dependency (single-line values only). */
export function frontmatter(skillName) {
  const text = CORPUS[skillName]["SKILL.md"];
  const body = text.split("---")[1] ?? "";
  const fields = {};
  for (const line of body.split("\n")) {
    const match = /^([a-z][a-z0-9-]*):\s*(.*)$/.exec(line.trim());
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}
