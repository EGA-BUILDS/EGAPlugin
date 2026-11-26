# EGAPlugin

Personal, authenticated **Skills over MCP** (SEP-2640) provider hosted on Cloudflare Workers Free, with Git and GitHub as the canonical skill store and lifecycle workflow.

EGAPlugin V1 replaces the complex `egawilldoit/ega-skills` platform with a minimal MCP-first architecture targeting **$0/month** hosting.

## Specification

- [SPEC-001 — EGAPlugin V1: MCP-First Personal Skill Provider](docs/specs/SPEC-001.md) (Revision 6 — MCP-only V1 baseline; `V1-001` feasibility gate required)
- [Archived Revision 5](docs/specs/archive/SPEC-001-rev5.md) (historical reference)

## Technical Stack

- **Runtime:** Cloudflare Workers Free (Wrangler)
- **Language:** TypeScript (strict mode)
- **Node.js / Package manager:** Node.js LTS (`.nvmrc`) + pnpm (`packageManager`)
- **Testing:** Vitest
- **Code quality:** ESLint + Prettier
- **CI / Deployment:** GitHub Actions + Wrangler

Planned V1 integrations pending **`V1-001`** feasibility verification (not yet implemented or provisioned): `@modelcontextprotocol/server` v2 (`ext/skills`, SEP-2640), Cloudflare Agents SDK (`createMcpHandler`), `workers-oauth-provider` + GitHub OAuth owner allowlist + 1 Cloudflare KV namespace.

## Development

```bash
pnpm install --frozen-lockfile
pnpm dev
```

## Verification & Testing

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run
```

Fresh checkouts install, pass all checks, and pass `wrangler deploy --dry-run` without Cloudflare or OAuth credentials.

## Status

- **Current phase:** Minimal Cloudflare Worker bootstrap complete (aligned with SPEC-001 Revision 6).
- **Next work package:** `V1-001` — SDK, OAuth, client compatibility, and CPU feasibility.
