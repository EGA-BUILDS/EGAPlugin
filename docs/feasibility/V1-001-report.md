# V1-001 Feasibility Report — EGAPlugin V1 (INCOMPLETE — Research Evidence Only)

> **Historical report.** Its closure criteria describe Revision 6. See the [live evidence](V010-002-live-evidence.md) and [proposed Revision 7 gates](../specs/SPEC-001.md#9-implementation-roadmap-5-work-packages) for the proposed release split.

> **Status at the time of research: INCOMPLETE.** Local `workerd` research was completed on 2026-11-26. Live Cloudflare Free CPU and startup, GitHub OAuth, distributed KV revocation, historical Version URLs, and real-client integration remain unverified. All experimental MCP and OAuth spike code was excluded from `main`. Start `V1-002` only after the [SPEC-001 §9 feasibility gate](../specs/SPEC-001.md#9-implementation-roadmap-5-work-packages) passes and the owner signs off.

| Field                        | Value                                                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**                   | **INCOMPLETE — Research Evidence Only**                                                                                                                                            |
| **Work Package**             | `V1-001` — SDK, OAuth, client compatibility & CPU feasibility                                                                                                                      |
| **Date**                     | 2026-11-26                                                                                                                                                                         |
| **Baseline Commit (`main`)** | `051b408d684b04b7d41f208cb2de72a6961109d6` (CI run `45850552005`: **PASS**)                                                                                                        |
| **Spike Code Disposition**   | Experimental MCP/OAuth spike kept out of `main` (local `workerd` evidence only; no production deployment)                                                                          |
| **Runtime Tested**           | Cloudflare `workerd` via `@cloudflare/vitest-plugin@1.9.2` + `wrangler@4.168.0`                                                                                                    |
| **Live Cloudflare Edge**     | **Incomplete** (Cloudflare token verified active & created/deleted disposable KV namespace; `wrangler deploy` returned `code: 10001` during Worker service authorization — see §6) |

---

## 1. Executive Recommendation

Continue feasibility with the smallest candidate tested locally. Keep `V1-001` open.

1. Use native SDK v2 `createMcpHandler`, `McpServer`, and `SkillsExtension` with the public Cloudflare Worker JSON Schema validator if needed. The spike used `@modelcontextprotocol/server@2.4.0`. Removing `agents@0.34.1` eliminated 26+ transitive packages in the spike. The measured five-skill bundle with OAuth, MCP, Skills, Zod, and three compatibility tools was 1.50 MiB uncompressed and 281.62 KiB gzipped.
2. Prefer a build-generated `SkillSource` using `skillEntry()`. Local catalog elapsed times were 20 ms at 50 skills and 36–44 ms at 100 skills for runtime construction. The precomputed path measured 0 ms at the timer's resolution for both larger samples. Confirm the preferred design with live measurements.
3. Retain the local fallback-tool evidence. Decide whether to implement any fallback tools after testing actual target clients. Installed CLI versions and the product announcement are inputs to that test plan.

---

## 2. Gate-by-Gate Evidence (`G1`–`G7`)

| Gate                                      | Status                                                           | Measured Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1 — Environment & Tooling**            | Local tooling verified. Live deployment open.                    | Verified pinned versions: `@modelcontextprotocol/server@2.4.0`, `@modelcontextprotocol/client@2.4.0` (dev), `@cloudflare/workers-oauth-provider@1.4.0`, `zod@4.6.7`, `@cloudflare/vitest-plugin@1.9.2`, `wrangler@4.168.0`. Adopted `@cloudflare/vitest-plugin` (`workerd`) and `wrangler types` (`spike/worker-configuration.d.ts`). Spike compatibility flags: `["nodejs_compat", "global_fetch_strictly_public"]`. Cloudflare API token verified active and created/deleted disposable KV namespace; `wrangler deploy` returned `code: 10001` (Worker service authorization failed).                                                                                                                                                                                                                                                                        |
| **G2 — Standard MCP (SEP-2640)**          | Local SDK paths observed.                                        | Official `Client` + `SkillsClient` connected over HTTP to `workerd` (`SELF.fetch`): `skills.supported === true`, `skills/list` (5 skills, 0 invalid), `skills/get`, `resources/read` (`SKILL.md` + `references/guide-1.md`, `verified === true`, SHA-256 + byte size + frontmatter verified). Modern `2026-07-28` `server/discover` verified (`200`, advertising `io.modelcontextprotocol/skills`). Observed in the spike: `SkillsExtension.load(memorySkillFiles(...), { strict: true })` silently skipped `.hidden-note.md`, proving why our 3-way inventory check (`skills/` vs. `generated/skills.ts` vs. MCP-exposed) is mandatory.                                                                                                                                                                                                                       |
| **G3 — Authentication (`OAuthProvider`)** | Local checks observed. Live GitHub OAuth open.                   | Single-Worker `OAuthProvider` + `OAUTH_KV` verified inside `workerd`: unauthenticated `/mcp` → `401` + `WWW-Authenticate: Bearer`; RFC 9728 metadata served at `/.well-known/oauth-protected-resource/mcp` (`200`, `scopes_supported: ["catalog:read"]`) and `404` at root `/.well-known/oauth-protected-resource`; `/.well-known/oauth-authorization-server` → `200`; DCR (`POST /register`) + PKCE strictly enforced (missing PKCE negative test → `400`); non-owner GitHub ID (`999999999`) rejected (`403`) both at `/authorize` and at handler; Explicit handler checks: missing `catalog:read` scope → `403 insufficient_scope` and wrong resource binding → `403 invalid_resource`; **Local access-token rejection:** deleting token keys from `OAUTH_KV` in the test caused `401 invalid_token`. Live GitHub OAuth redirect pending live spike Worker. |
| **G4 — Client Compatibility**             | Local tool tests and CLI inventory. Real-client acceptance open. | 3 fallback tools (`search_skills`, `get_skill`, `get_skill_file`) verified in `workerd` sharing the exact same catalog & auth boundary; path traversal (`../secret.txt`) rejected (`isError: true`). Local CLIs inspected: `claude 2.1.167`, `codex-cli 0.172.0`, `opencode v2.4.2`, `Hermes Agent v0.23.4` (see §4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **G5 — Performance Benchmarks**           | Local elapsed-time samples only. Live performance open.          | Benchmarked 1, 10, 50 (300 files), and 100 (600 files) skills in `workerd` (see §3). Full authenticated HTTP `skills/list` (20 warm requests through `OAuthProvider` + KV + `createMcpHandler`): **p50 = `3 ms`, p95 = `3–4 ms`, max = `5 ms`** in the historical gate summary. These are local wall-clock observations. Live Cloudflare edge CPU telemetry and startup measurements remain pending.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **G6 — Security**                         | Local checks observed. Live controls open.                       | `Cache-Control: private, no-store` enforced on all responses; `preview_urls: false` configured; `resourceMetadata.resource` required as absolute HTTPS URI by `workers-oauth-provider@1.4.0`; local access-token rejection observed after test KV deletion (`401`). Live multi-region access-token and refresh-grant revocation and historical Version URL checks remain pending.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **G7 — Decision**                         | Candidate architecture only.                                     | Smallest candidate exercised locally: `@modelcontextprotocol/server@2.4.0` + `@cloudflare/workers-oauth-provider@1.4.0` + `zod@4.6.7` + build-time precomputed `SkillSource` (`skillEntry()`). No `agents`, no Durable Objects, no DB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

---

## 3. Benchmark Results (`workerd`)

These are local elapsed-time samples. Catalog initialization and lookup timings do not establish per-invocation edge CPU time or global-scope startup duration. The reported warm HTTP sample measures the full authenticated local call, including waits. Live acceptance must record these metrics separately, including end-to-end latency for both cold and warm requests.

### 3.1 Local catalog initialization and lookup

| Scenario                 | Files   | Raw Size      | Strategy A: `SkillsExtension.load(memorySkillFiles)` | Strategy B: Precomputed `SkillSource` (`skillEntry()`) |
| ------------------------ | ------- | ------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| Minimal (1 skill)        | 6       | 1.5 KiB       | `0–1 ms`                                             | `0–1 ms`                                               |
| Small (10 skills)        | 60      | 14.5 KiB      | `4–5 ms`                                             | `0 ms`                                                 |
| **Expected (50 skills)** | **300** | **72.9 KiB**  | **`20 ms`**                                          | **`0 ms`**                                             |
| **Stress (100 skills)**  | **600** | **145.9 KiB** | **`36–44 ms`**                                       | **`0 ms`**                                             |

### 3.2 Authenticated HTTP `skills/list` (20 warm requests in `workerd`)

- Full path: `SELF.fetch` → `OAuthProvider` (KV lookup) → explicit owner/scope check → `createMcpHandler` → `SkillsExtension` → JSON response.
- The detailed spike record lists p50 as `3 ms`, p95 as `3 ms`, and max as `5 ms`. The gate summary records p95 as `3–4 ms`. The historical report contains no raw samples to reconcile those two p95 reports.

### 3.3 Worker bundle size (`wrangler deploy --dry-run`)

- **5-skill spike (+ Zod + 3 fallback tools):** `1,531.99 KiB` uncompressed (`1.50 MiB` / `64 MiB` Free limit = **2.3%**) · `281.62 KiB` gzipped
- **100-skill (600-file) precomputed `SkillSource` + `OAuthProvider` + `@modelcontextprotocol/server@2.4.0`:** `1,271.44 KiB` uncompressed (`1.24 MiB` / `64 MiB` Free limit = **1.9%**) · `238.30 KiB` gzipped (no compressed limit on Workers Free)

---

## 4. Client observations from 2026-11-26

| Client                  | Installed local version              | Evidence                                                                                                                |
| ----------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Claude Code             | `2.1.167`                            | CLI inventory. Anthropic announced native Skills over MCP in public beta. Real EGAPlugin integration was not exercised. |
| Codex CLI               | `0.172.0`                            | CLI inventory. Native Skills and fallback consumption were not exercised with EGAPlugin.                                |
| OpenCode                | `v2.4.2`                             | CLI inventory. Native Skills and fallback consumption were not exercised with EGAPlugin.                                |
| Hermes Agent            | `v0.23.4`                            | CLI inventory. Native Skills and fallback consumption were not exercised with EGAPlugin.                                |
| Official `SkillsClient` | `@modelcontextprotocol/client@2.4.0` | Local HTTP discovery and verified reads in `workerd` via `StreamableHTTPClientTransport`.                               |

The CLI versions are historical inventory. Native client acceptance, fallback-tool necessity, and official conformance suite results remain open. [Anthropic product announcement](https://claude.com/resources/articles/skills-over-mcp-tasks-and-more)

---

## 5. Key Security & Protocol Findings

1. **RFC 9728 path-scoped discovery URL & snake_case field:** `workers-oauth-provider@1.4.0` requires `resourceMetadata.resource` to be an absolute HTTPS URI and `scopes_supported` (snake_case, not `scopesSupported`), serving protected-resource metadata at `/.well-known/oauth-protected-resource/mcp` (matching `apiRoute: "/mcp"`), returning `404` at root `/.well-known/oauth-protected-resource`.
2. **CIMD SSRF protection:** `workers-oauth-provider@1.4.0` disables Client ID Metadata Document (CIMD) unless `"global_fetch_strictly_public"` is included in `compatibility_flags`.
3. **Strict PKCE enforcement:** `OAuthProvider.parseAuthRequest` automatically rejects public clients without PKCE (`AuthorizationError`).
4. **Explicit handler enforcement:** Verified that checking `ctx.props.githubUserId === env.GITHUB_OWNER_ID` and `ctx.props.scopes.includes("catalog:read")` inside `apiHandler` blocks both wrong-owner tokens and missing-scope tokens with `403` + `WWW-Authenticate: Bearer error="insufficient_scope"`.
5. **Dotfile skip observation:** Confirmed `SkillsExtension.load(memorySkillFiles(...), { strict: true })` silently skips `.hidden-note.md`; `V1-003` build script must fail on dotfiles and run the 3-way inventory check.
6. **Local legacy flow and modern discovery:** `StreamableHTTPClientTransport` in `@modelcontextprotocol/client@2.4.0` negotiated 2025-era by default (where `cacheScope`/`ttlMs` are omitted), while direct `2026-07-28` `server/discover` with the required `io.modelcontextprotocol/clientCapabilities` envelope returned `200` advertising `io.modelcontextprotocol/skills`. The spike set HTTP `Cache-Control: private, no-store` independently of protocol era. The observed modern discovery response does not establish coverage of the full modern protocol.

---

## 6. Remaining Open Items (Live Cloudflare Edge)

The earlier spike confirmed account access by creating and deleting a disposable KV namespace. The Worker deployment attempt returned `10001 Unable to authenticate request` at the Worker service API. Missing `Workers Scripts:Edit` was the suspected cause. No spike Worker was deployed.

Before closing `V1-001`, gather the following evidence in an owner-authorized non-production environment.

1. Live Cloudflare Free edge CPU, global-scope startup, and cold and warm authenticated end-to-end latency for the proposed immutable catalog.
2. Live GitHub OAuth with real owner identity and token scope, audience and expiry checks.
3. Distributed KV propagation for access-token and refresh-grant revocation.
4. Historical Version URLs disabled or enforcing the same OAuth controls.
5. Real target-client integration, recording native Skills and compatibility tools separately.

An authorized test deployment requires an appropriately scoped Cloudflare credential and a separate test GitHub OAuth App. The remaining production-stage tests, including rollback and emergency withdrawal, are governed by SPEC-001 §9 and §12.
