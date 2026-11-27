/**
 * Type contract for the build-generated catalog module. The catalog builder
 * produces `generated/skills.ts`; `wrangler.jsonc` maps this specifier to it at
 * bundle time.
 */
import type { CatalogSkill } from "./catalog";

export const SKILLS: readonly CatalogSkill[];
export const SKILL_FILES: Readonly<Record<string, string>>;
