# V1-001 Feasibility Report — EGAPlugin V1 (INCOMPLETE — Research Evidence Only)

> **Status: INCOMPLETE (Paused at V0 Baseline).** This report preserves local `workerd` feasibility research conducted on 2026-11-26. Live Cloudflare Free edge deployment, live multi-region KV revocation timing, historical Version URL checks, and real-host GitHub OAuth testing were **not completed**. All experimental MCP and OAuth spike code was intentionally excluded from `main`.

| Field                        | Value                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Status**                   | **INCOMPLETE — Research Evidence Only**                                                                                                                                                    |
| **Work Package**             | `V1-001` — SDK, OAuth, client compatibility & CPU feasibility                                                                                                                              |
| **Date**                     | 2026-11-26                                                                                                                                                                                 |
| **Baseline Commit (`main`)** | `051b408d684b04b7d41f208cb2de72a6961109d6` (CI run `45850552005`: **PASS**)                                                                                                                |
| **Spike Code Disposition**   | Experimental MCP/OAuth spike kept out of `main` (local `workerd` evidence only; no production deployment)                                                                                  |
| **Runtime Tested**           | Cloudflare `workerd` via `@cloudflare/vitest-plugin@1.9.2` + `wrangler@4.168.0`                                                                                                            |
| **Live Cloudflare Edge**     | **Incomplete** (Cloudflare token verified active & created/deleted disposable KV namespace; `wrangler deploy` returned `code: 10001` due to missing `Workers Scripts:Edit` scope — see §6) |

---

## 1. Executive Recommendation

**GO for `V1-002`, with one mandatory architectural adjustment discovered by `V1-001`:**

1. **Drop the `agents` package completely.** `@modelcontextprotocol/server@2.4.0` natively exports `createMcpHandler`, `McpServer`, `SkillsExtension`, and `CfWorkerJsonSchemaValidator` with full Cloudflare Workers support. Removing `agents@0.34.1` eliminates 26+ transitive packages and keeps the full Worker bundle (OAuth + MCP + Skills + Zod + 3 fallback tools) to **`1.50 MiB` uncompressed (`281.62 KiB` gzip)** — **2.3%** of Cloudflare Workers Free's 64 MiB limit.
2. **Use build-time precomputed `SkillSource` (`skillEntry()`) instead of runtime `SkillsExtension.load(memorySkillFiles(...))`.** Our `workerd` benchmark proved that `SkillsExtension.load(memorySkillFiles)` takes **20 ms at 50 skills (300 files)** and **36–44 ms at 100 skills (600 files)** — **exceeding Cloudflare Workers Free's 10 ms CPU limit**. Precomputing `Skill` entries at build time via `skillEntry()` reduces runtime initialization, listing, and reading to **`< 1 ms` (`0 ms` measured)** across 1, 10, 50, and 100 skills!
3. **Keep the 3 fallback tools (`search_skills`, `get_skill`, `get_skill_file`) in `V1-002`.** Only Claude Code (`2.1.167`) currently has public beta native Skills over MCP; Codex (`0.172.0`), OpenCode (`2.4.2`), and Hermes (`0.23.4`) require fallback MCP tools or `.agents/skills/` local discovery.

---

## 2. Gate-by-Gate Evidence (`G1`–`G7`)

| Gate                                      | Status                                                       | Measured Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1 — Environment & Tooling**            | **PASS (local) / PARTIAL (live CF deploy)**                  | Verified pinned versions: `@modelcontextprotocol/server@2.4.0`, `@modelcontextprotocol/client@2.4.0` (dev), `@cloudflare/workers-oauth-provider@1.4.0`, `zod@4.6.7`, `@cloudflare/vitest-plugin@1.9.2`, `wrangler@4.168.0`. Adopted `@cloudflare/vitest-plugin` (`workerd`, F06) and `wrangler types` (F07 → `spike/worker-configuration.d.ts`). Compatibility flags needed: `["nodejs_compat", "global_fetch_strictly_public"]`. Cloudflare API token verified active and created/deleted disposable KV namespace; `wrangler deploy` returned `code: 10001` (missing `Workers Scripts:Edit`).                                                                                                                                                                                                                                                    |
| **G2 — Standard MCP (SEP-2640)**          | **PASS (`workerd`)**                                         | Official `Client` + `SkillsClient` connected over HTTP to `workerd` (`SELF.fetch`): `skills.supported === true`, `skills/list` (5 skills, 0 invalid), `skills/get`, `resources/read` (`SKILL.md` + `references/guide-1.md`, `verified === true`, SHA-256 + byte size + frontmatter verified). Modern `2026-07-28` `server/discover` verified (`200`, advertising `io.modelcontextprotocol/skills`). **F09 confirmed:** `SkillsExtension.load(memorySkillFiles(...), { strict: true })` silently skipped `.hidden-note.md`, proving why our 3-way inventory check (`skills/` vs. `generated/skills.ts` vs. MCP-exposed) is mandatory.                                                                                                                                                                                                              |
| **G3 — Authentication (`OAuthProvider`)** | **PASS (`workerd`) / PARTIAL (live GitHub OAuth)**           | Single-Worker `OAuthProvider` + `OAUTH_KV` verified inside `workerd`: unauthenticated `/mcp` → `401` + `WWW-Authenticate: Bearer`; RFC 9728 metadata served at `/.well-known/oauth-protected-resource/mcp` (`200`, `scopes_supported: ["catalog:read"]`) and `404` at root `/.well-known/oauth-protected-resource`; `/.well-known/oauth-authorization-server` → `200`; DCR (`POST /register`) + PKCE strictly enforced (missing PKCE negative test → `400`); non-owner GitHub ID (`999999999`) rejected (`403`) both at `/authorize` and at handler; **F08 verified:** missing `catalog:read` scope → `403 insufficient_scope` and wrong resource binding → `403 invalid_resource`; **KV revocation verified:** deleting token keys from `OAUTH_KV` immediately causes `401 invalid_token`. Live GitHub OAuth redirect pending live spike Worker. |
| **G4 — Client Compatibility**             | **PASS (protocol + CLI inventory) / PARTIAL (live host UX)** | 3 fallback tools (`search_skills`, `get_skill`, `get_skill_file`) verified in `workerd` sharing the exact same catalog & auth boundary; path traversal (`../secret.txt`) rejected (`isError: true`). Local CLIs inspected: `claude 2.1.167`, `codex-cli 0.172.0`, `opencode v2.4.2`, `Hermes Agent v0.23.4` (see §4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **G5 — Performance Benchmarks**           | **PASS (`workerd`, with `SkillSource`)**                     | Benchmarked 1, 10, 50 (300 files), and 100 (600 files) skills in `workerd` (see §3). Full authenticated HTTP `skills/list` (20 warm requests through `OAuthProvider` + KV + `createMcpHandler`): **p50 = `3 ms`, p95 = `3–4 ms`, max = `5 ms`** (within `<= 5 ms` target). Live Cloudflare edge CPU telemetry pending `Workers Scripts:Edit` token scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **G6 — Security**                         | **PASS (`workerd`) / PARTIAL (live edge)**                   | `Cache-Control: private, no-store` enforced on all responses; `preview_urls: false` configured; `resourceMetadata.resource` required as absolute HTTPS URI by `workers-oauth-provider@1.4.0`; local KV token revocation verified (`401`). Live multi-region KV revocation propagation latency and live historical Version URL check pending `Workers Scripts:Edit` token scope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **G7 — Decision**                         | **PASS**                                                     | Smallest proven stack: `@modelcontextprotocol/server@2.4.0` + `@cloudflare/workers-oauth-provider@1.4.0` + `zod@4.6.7` + build-time precomputed `SkillSource` (`skillEntry()`). No `agents`, no Durable Objects, no DB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

---

## 3. Benchmark Results (`workerd`)

### 3.1 Catalog initialization & lookup (Strategy A vs. Strategy B)

| Scenario                 | Files   | Raw Size      | Strategy A: `SkillsExtension.load(memorySkillFiles)` | Strategy B: Precomputed `SkillSource` (`skillEntry()`) |
| ------------------------ | ------- | ------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| Minimal (1 skill)        | 6       | 1.5 KiB       | `0–1 ms`                                             | `0–1 ms`                                               |
| Small (10 skills)        | 60      | 14.5 KiB      | `4–5 ms`                                             | `0 ms`                                                 |
| **Expected (50 skills)** | **300** | **72.9 KiB**  | **`20 ms` (EXCEEDS 10 ms Free CPU limit)**           | **`0 ms`**                                             |
| **Stress (100 skills)**  | **600** | **145.9 KiB** | **`36–44 ms` (EXCEEDS 10 ms Free CPU limit)**        | **`0 ms`**                                             |

### 3.2 Authenticated HTTP `skills/list` (20 warm requests in `workerd`)

- Full path: `SELF.fetch` → `OAuthProvider` (KV lookup) → explicit owner/scope check → `createMcpHandler` → `SkillsExtension` → JSON response.
- **p50:** `3 ms` · **p95:** `3 ms` · **max:** `5 ms` (target: `<= 5 ms`).

### 3.3 Worker bundle size (`wrangler deploy --dry-run`)

- **5-skill spike (+ Zod + 3 fallback tools):** `1,531.99 KiB` uncompressed (`1.50 MiB` / `64 MiB` Free limit = **2.3%**) · `281.62 KiB` gzipped
- **100-skill (600-file) precomputed `SkillSource` + `OAuthProvider` + `@modelcontextprotocol/server@2.4.0`:** `1,271.44 KiB` uncompressed (`1.24 MiB` / `64 MiB` Free limit = **1.9%**) · `238.30 KiB` gzipped (no compressed limit on Workers Free)

---

## 4. Client Compatibility Matrix (Observed 2026-11-26)

| Client                      | Installed Local Version              | Remote HTTP MCP                         | Native SEP-2640 Skills over MCP      | Recommended V1 Path                              |
| --------------------------- | ------------------------------------ | --------------------------------------- | ------------------------------------ | ------------------------------------------------ |
| **Claude Code**             | `2.1.167`                            | Yes (`claude mcp add --transport http`) | Public beta (Anthropic Nov 24, 2026) | Primary SEP-2640 remote MCP                      |
| **Codex CLI**               | `0.172.0`                            | Yes (`codex mcp add --url`)             | Planned (not yet native)             | 3 MCP fallback tools + `.agents/skills/` locally |
| **OpenCode**                | `v2.4.2`                             | Yes (`opencode mcp`)                    | Experimental / WIP                   | 3 MCP fallback tools + `.agents/skills/` locally |
| **Hermes Agent**            | `v0.23.4`                            | Yes                                     | Community PR in progress             | 3 MCP fallback tools                             |
| **Official `SkillsClient`** | `@modelcontextprotocol/client@2.4.0` | Yes (`StreamableHTTPClientTransport`)   | Verified (`workerd` E2E PASS)        | Automated CI conformance harness                 |

---

## 5. Key Security & Protocol Findings

1. **RFC 9728 path-scoped discovery URL & snake_case field:** `workers-oauth-provider@1.4.0` requires `resourceMetadata.resource` to be an absolute HTTPS URI and `scopes_supported` (snake_case, not `scopesSupported`), serving protected-resource metadata at `/.well-known/oauth-protected-resource/mcp` (matching `apiRoute: "/mcp"`), returning `404` at root `/.well-known/oauth-protected-resource`.
2. **CIMD SSRF protection:** `workers-oauth-provider@1.4.0` disables Client ID Metadata Document (CIMD) unless `"global_fetch_strictly_public"` is included in `compatibility_flags`.
3. **Strict PKCE enforcement:** `OAuthProvider.parseAuthRequest` automatically rejects public clients without PKCE (`AuthorizationError`).
4. **Explicit handler enforcement (F08):** Verified that checking `ctx.props.githubUserId === env.GITHUB_OWNER_ID` and `ctx.props.scopes.includes("catalog:read")` inside `apiHandler` blocks both wrong-owner tokens and missing-scope tokens with `403` + `WWW-Authenticate: Bearer error="insufficient_scope"`.
5. **Dotfile skip proof (F09):** Confirmed `SkillsExtension.load(memorySkillFiles(...), { strict: true })` silently skips `.hidden-note.md`; `V1-003` build script must fail on dotfiles and run the 3-way inventory check.
6. **Protocol negotiation verified (2025-era + 2026-07-28):** `StreamableHTTPClientTransport` in `@modelcontextprotocol/client@2.4.0` negotiated 2025-era by default (where `cacheScope`/`ttlMs` are omitted), while direct `2026-07-28` `server/discover` with the required `io.modelcontextprotocol/clientCapabilities` envelope returned `200` advertising `io.modelcontextprotocol/skills`. Setting HTTP `Cache-Control: private, no-store` ensures private caching regardless of negotiated MCP protocol era.

---

## 6. Remaining Open Items (Live Cloudflare Edge)

The provided Cloudflare API token was verified active and successfully created and deleted a disposable KV namespace (`ega-plugin-v1-001-spike-oauth-kv`, cleaned up after testing), confirming account access. However, `wrangler deploy` returned `code: 10001 Unable to authenticate request` on `/workers/services/ega-plugin-v1-001-spike`, indicating the token lacks `Workers Scripts:Edit` permission. Consequently, the following **live-edge** measurements remain open before `V1-004` production deployment:

1. **Live Cloudflare Free edge CPU telemetry** on a disposable spike Worker (to confirm `workerd` local timings match Cloudflare edge CPU accounting).
2. **Live multi-region KV token revocation latency** (eventual consistency window).
3. **Live Cloudflare historical Version URL check** (`<version-id>-ega-plugin...workers.dev` disabled or enforcing identical OAuth).
4. **Live GitHub OAuth redirect** with a real MCP client (Claude Code `2.1.167` / Codex `0.172.0`).

These can be completed once a token with `Account: Workers Scripts:Edit` (in addition to `Workers KV Storage:Edit` and `Account Settings:Read`) and a test GitHub OAuth App are available.
