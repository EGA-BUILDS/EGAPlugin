# EGAPlugin

EGAPlugin is a personal, authenticated Skills over MCP provider. The `v0.1.0` implementation serves a fixture catalog for local verification.

The Worker serves one authenticated Streamable HTTP MCP endpoint at `/mcp` through the MCP SDK v2 `createMcpHandler` and the SEP-2640 Skills extension, backed by the immutable build-generated catalog. Authorization uses the Workers OAuth provider, GitHub owner identity and one KV namespace. The Worker fails closed when the protected-resource configuration is missing, and it is not deployed permanently. The [live spike evidence](docs/feasibility/V010-002-live-evidence.md) records measured results, failed checks and open gates. The [original feasibility report](docs/feasibility/V1-001-report.md) preserves the earlier local research.

## Planned V1 architecture

[**SPEC-001 Revision 7**](docs/specs/SPEC-001.md) governs this implementation. V1 targets Cloudflare Workers Free with a native MCP TypeScript SDK v2 `createMcpHandler`, the official SEP-2640 Skills extension, and one immutable skill catalog generated from approved Git files. The authentication design uses the Workers OAuth provider, GitHub owner identity, and one KV namespace. The [archived Revision 5](docs/specs/archive/SPEC-001-rev5.md) is a historical reference.

## Local development

```bash
pnpm install --frozen-lockfile
pnpm build:skills
pnpm dev
```

`pnpm build:skills` renders `generated/skills.ts` from the approved files under `skills/`. The module is gitignored and required before bundling, Worker-runtime tests or a deployment dry run.

## Verification

```bash
pnpm build:skills
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run
```

These checks cover the bootstrap and a local bundle build. They require no Cloudflare or OAuth credentials.
