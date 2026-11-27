# V010-008 — Local protocol verification evidence

| Field  | Value                                                                  |
| ------ | ---------------------------------------------------------------------- |
| Task   | V010-008 (protocol-test slice)                                         |
| Base   | SPEC-001 Revision 7, merged `737dd0754304764cf8bc7a945c083a666faba71a` |
| Date   | 2026-11-27                                                             |
| Scope  | Local protocol tests only; no deployment, live, or performance work    |
| Status | Fixture suites and release runtime integration passed locally          |

This slice supplies the local protocol verification required by SPEC-001
Revision 7 §12.4. It does not implement the runtime, mutate the catalog, test
live Cloudflare behavior, or exercise owner authorization. Authorization is a
separate V010-008 slice.

## Pinned tools

| Tool                           | Version                                             |
| ------------------------------ | --------------------------------------------------- |
| Node.js                        | `24.18.0`                                           |
| pnpm                           | `10.0.0`                                            |
| `@modelcontextprotocol/client` | `2.4.0`                                             |
| `@modelcontextprotocol/server` | `2.4.0`                                             |
| `zod`                          | `4.6.7`                                             |
| Vitest                         | `5.1.1`                                             |
| Fixture                        | Public synthetic corpus, 3 skills / 7 exposed files |

The fixture dependencies are isolated under `tests/protocol/fixture` and are
never added to the Worker bundle or deployed.

## Artifacts

- [`tests/protocol/mcp-suite.mjs`](../../tests/protocol/mcp-suite.mjs)
- [`tests/protocol/official-client.mjs`](../../tests/protocol/official-client.mjs)
- [`tests/protocol/protocol.test.ts`](../../tests/protocol/protocol.test.ts)
- [`tests/protocol/fixture/`](../../tests/protocol/fixture/)
- [`tests/protocol/run-local.sh`](../../tests/protocol/run-local.sh)

## Commands and results

```bash
# Test-only fixture dependency install
cd tests/protocol/fixture
npm install --no-audit --no-fund --ignore-scripts

# Wire suite + official client
tests/protocol/run-local.sh

# Vitest wrapper
pnpm exec vitest run tests/protocol/protocol.test.ts
```

| Layer                   | Result                                                      |
| ----------------------- | ----------------------------------------------------------- |
| Wire suite              | **39 pass, 0 fail, 1 optional skip** (`AUTH-01`, by design) |
| Official client, modern | **10 pass, 0 fail**                                         |
| Official client, legacy | **7 pass, 0 fail**                                          |
| Vitest wrapper          | **1 file, 2 tests passed**                                  |

The optional `AUTH-01` skip is deliberate: this slice does not test owner
authorization. Origin checks (`ORIGIN-01` … `ORIGIN-04`) run with the fixture
allowlist and pass in both eras.

## Covered behavior

- Modern `2026-07-28`: `server/discover`, `_meta` envelope, manifests, sizes,
  SHA-256 digests, pagination stability, direct `skills/get`, exact
  `resources/read`, cache hints, tool inventory, traversal rejection, unknown
  skills, resource/template inventory.
- Legacy 2025-era: `initialize`, skills capability, initialized notification,
  tools, exact reads, version fallback, absence of modern cache fields, and
  `private, no-store` HTTP policy.
- Cross-era: same approved file set and bytes; legacy fallback tools match the
  modern native manifest and bytes.
- Robustness: malformed JSON, unsupported modern version, and six malformed
  cursor variants are rejected without `5xx` or catalog leakage.
- Official client: pinned `Client` negotiates modern and legacy; `SkillsClient`
  verifies every file; direct `get` matches; fallback tools match native bytes;
  malformed cursors are rejected through the client path.

## Runtime integration

The suite targets any reachable `/mcp` endpoint. No test bypass or token
minting exists.

```bash
pnpm exec wrangler dev --local --port 8787
MCP_TEST_URL=http://127.0.0.1:8787/mcp \
ALLOWED_ORIGIN=https://allowed.example \
tests/protocol/run-local.sh
```

The runtime must expose modern and legacy negotiation through the pinned SDK,
serve one generated catalog for native and fallback paths, reject malformed
cursors, gate disallowed Origin before dispatch, and use `private, no-store`
plus modern `cacheScope: "private"` / `ttlMs: 0`. The complete contract is in
[`tests/protocol/README.md`](../../tests/protocol/README.md).

## Release runtime verification

- `tests/worker.test.ts` exchanges a synthetic local grant through the Worker OAuth token endpoint and verifies authenticated discovery and Unicode fallback retrieval in both protocol eras. The grant is local to workerd KV.
- `tests/catalog-runtime.test.ts` exercises the released SDK handler and generated catalog, including discovery and initialization, five-entry pagination, native retrieval, and fallback parity for all 7 skills and 19 files.
- The separate fixture suites remain reference protocol checks. Their results do not represent a run against a deployed release Worker.
- Live CPU and latency, distributed revocation, historical URLs, and real-client acceptance retain the deferrals in SPEC-001.
