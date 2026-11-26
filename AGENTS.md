# Agent Guidance — EGAPlugin

[SPEC-001](docs/specs/SPEC-001.md) (Revision 6 — MCP-only V1) is the single architectural authority for this repository. Revision 5 is archived for historical reference at [docs/specs/archive/SPEC-001-rev5.md](docs/specs/archive/SPEC-001-rev5.md).

## Mandatory rules

1. **Read `docs/specs/SPEC-001.md` before implementation.** Do not invent parallel contracts or reintroduce deferred platform-first complexity.
2. **Work on one approved issue at a time** in the dependency order defined in SPEC-001 §9 (`V1-001` → `V1-005`).
3. **Respect the V1 infrastructure budget** (SPEC-001 §2.3). Prefer native standards and existing libraries; do not introduce frontend frameworks, application databases, Durable Objects, or extra services.
4. **Do not implement future work packages prematurely.**
5. **Never expose secrets** in Git, logs, or generated bundles.
6. **Never execute untrusted upstream scripts or hooks** in local, CI, or Worker runtimes.
7. **Never push private content to a public repository or deploy to production without explicit owner approval.**
8. **Use PR-based changes** after the initial repository bootstrap.
9. **Run relevant checks before requesting review:** `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, and `pnpm exec wrangler deploy --dry-run`.
10. **Stop and report** whenever an implementation requirement contradicts SPEC-001 or fails a feasibility/security gate.
