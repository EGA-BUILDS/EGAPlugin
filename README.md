# EGAPlugin

**Current release baseline: `v0.0.1`.** This documentation release establishes the architecture and engineering contract for a personal, authenticated Skills over MCP provider.

The application is a minimal, undeployed Cloudflare Worker bootstrap. The repository has no live MCP endpoint, OAuth functionality, or Cloudflare deployment. [V1-001 feasibility](docs/feasibility/V1-001-report.md) remains incomplete. Local spike research is recorded there, while the edge and real-client acceptance gates are still open.

## Planned V1 architecture

[**SPEC-001 Revision 6**](docs/specs/SPEC-001.md) is the architecture authority. V1 targets Cloudflare Workers Free with a native MCP TypeScript SDK v2 `createMcpHandler`, the official SEP-2640 Skills extension, and one immutable skill catalog generated from approved Git files. The proposed authentication design uses the Workers OAuth provider, GitHub owner identity, and one KV namespace. The [archived Revision 5](docs/specs/archive/SPEC-001-rev5.md) is a historical reference.

## Local development

```bash
pnpm install --frozen-lockfile
pnpm dev
```

## Verification

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run
```

These checks cover the bootstrap and a local bundle build. They require no Cloudflare or OAuth credentials.
