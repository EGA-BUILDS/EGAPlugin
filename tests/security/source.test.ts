import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) out.push(path);
  }
  return out;
}

it("keeps the production runtime free of test bypass knobs", () => {
  const forbidden = [
    "SPIKE_MODE",
    "bypass_auth_check",
    "test_github_id",
    "test_scopes",
    "test_resource",
  ];
  const sourceRoot = join(process.cwd(), "src");
  const findings = walkFiles(sourceRoot).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return forbidden
      .filter((needle) => source.includes(needle))
      .map((needle) => `${file.replace(process.cwd(), ".")}: ${needle}`);
  });

  expect(findings).toEqual([]);
});
