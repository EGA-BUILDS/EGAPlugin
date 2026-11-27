# V010-008 local protocol verification

Test-only protocol verification for the EGAPlugin Phase B Worker. This slice
implements the local layers required by SPEC-001 Revision 7 §12.4 for v0.1.0.
It does not deploy, benchmark, provision, or test live infrastructure.

The suite is derived from the validated V010-002 acceptance harness
(`scripts/acceptance/mcp-suite.mjs` and `fixtures/acceptance-server/` at
`5e72e96`). Only sanitized public synthetic content and the protocol behaviors
were carried forward. The V010-002 installed-client probes and live-endpoint
runbook are out of scope here.

## Scope

In scope:

- Modern `2026-07-28` request/response behavior, including `server/discover`.
- Legacy 2025-era `initialize` negotiation and stateless compatibility.
- Official pinned `@modelcontextprotocol/client@2.4.0` `Client` and
  `SkillsClient` coverage for both eras.
- Native SEP-2640 and fallback-tool parity: manifests, URIs, sizes, SHA-256
  digests, and exact bytes.
- Pagination stability, page bounds where the server exposes cursors, and
  malformed-cursor rejection.
- Malformed JSON, unsupported protocol version, Origin gating, and
  `private, no-store` response policy.

Out of scope:

- Authorization, owner identity, token scope/audience/expiry (separate
  V010-008 auth slice; this suite never mints, accepts, or bypasses tokens).
- Live Cloudflare CPU/startup/latency, KV revocation, historical version URLs,
  deployment, merge, or real-client acceptance.

## Artifacts

| Path                                 | Purpose                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `tests/protocol/mcp-suite.mjs`       | Dependency-free JSON-RPC wire suite for modern, legacy, cross-era parity, Origin, malformed input, and cursors       |
| `tests/protocol/official-client.mjs` | Official pinned `Client` + `SkillsClient` suite for modern and legacy negotiation, native reads, and fallback parity |
| `tests/protocol/protocol.test.ts`    | Vitest wrapper: starts the fixture, or targets `MCP_TEST_URL`, and asserts both layers pass                          |
| `tests/protocol/fixture/`            | Test-only SEP-2640 reference server and public synthetic corpus on the pinned SDK; never deployed                    |
| `tests/protocol/run-local.sh`        | One-command fixture run, or `MCP_TEST_URL` integration run                                                           |

## Coverage

| Area            | IDs                                                      | Required behavior                                                                                                                                                                                                           |
| --------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modern          | `MOD-01` … `MOD-19`                                      | `server/discover`, `2026-07-28`, `_meta` envelope, manifests and digests, pagination, direct lookup, exact bytes, cache hints, tool set, traversal rejection, unknown skills, resource inventory                            |
| Legacy          | `LEG-01` … `LEG-09`                                      | `initialize`, skills capability, initialized notification, tools, exact reads, version fallback, no modern cache fields, private/no-store                                                                                   |
| Cross-era       | `X-01` … `X-03`                                          | Same approved file set and bytes across eras; legacy fallback matches modern native manifest and bytes                                                                                                                      |
| Origin          | `ORIGIN-01` … `ORIGIN-04`                                | Disallowed and malformed Origin return 403 before dispatch in both eras; allowed Origin reaches the handler                                                                                                                 |
| Robustness      | `MAL-01`, `MAL-02`, `CUR-01`, `CUR-02`                   | Malformed JSON and unsupported modern versions fail safely; malformed cursor variants are rejected, never ignored, with no 5xx or catalog leak                                                                              |
| Official client | `SDK-MOD-01` … `SDK-MOD-10`, `SDK-LEG-01` … `SDK-LEG-07` | Pinned client negotiates modern and legacy, `SkillsClient` verifies every file, direct `get` matches, fallback tools match native bytes, unknown skills/files are rejected, malformed cursor is rejected through the client |

A skipped required check makes the wire suite exit `2` (incomplete), not `0`.

## Run locally

```bash
# One-time test-only dependency install (pinned, nested package)
cd tests/protocol/fixture
npm install --no-audit --no-fund --ignore-scripts

# Wire suite + official client against the local fixture
cd ../../..
tests/protocol/run-local.sh
```

Or through Vitest:

```bash
pnpm test -- tests/protocol/protocol.test.ts
```

The Vitest wrapper skips cleanly when the fixture dependencies are not
installed. `run-local.sh` exits `2` in that case unless `INSTALL=1` is set.

## Runtime integration contract

The tests are implementation-agnostic. They need a reachable Streamable HTTP
endpoint that serves `/mcp` and the exact approved catalog. Recommended
integration flow after the runtime and catalog land:

```bash
# Local Worker (no deployment)
pnpm exec wrangler dev --local --port 8787

# Point the suite at it (no fixture, no test bypass)
MCP_TEST_URL=http://127.0.0.1:8787/mcp \
ALLOWED_ORIGIN=https://allowed.example \
tests/protocol/run-local.sh
```

Contract points the runtime must satisfy:

1. `/mcp` accepts modern `2026-07-28` and legacy 2025-era negotiation through
   the pinned SDK. No custom negotiation, custom JSON-RPC, or duplicate
   SEP-2640 path.
2. `skills/list`, `skills/get`, `resources/read`, and the three fallback tools
   read the same generated catalog and return the same bytes, sizes, and
   `sha256:<lowercase-hex>` digests.
3. Malformed `skills/list` cursors are rejected as invalid params (`-32602`),
   invalid request (`-32600`), or HTTP `400`/`422`. They must not be silently
   ignored, return `5xx`, or leak catalog data.
4. Disallowed or malformed `Origin` returns HTTP `403` before SDK dispatch in
   both eras. Requests without `Origin` still follow the normal auth path.
5. Protected responses carry `Cache-Control: private, no-store`; modern
   cacheable results use `cacheScope: "private"` and `ttlMs: 0`.
6. The official pinned client SDK must be resolvable for the integration run.
   The runtime package may add `@modelcontextprotocol/client@2.4.0` as a
   dev dependency; otherwise the suite uses the fixture's pinned copy.
7. Fallback tools must resolve the catalog's percent-encoded resource URIs for
   non-ASCII paths. `get_skill_file` receives a decoded relative path, so it
   must encode path segments or compare decoded URIs against the manifest.
   `MOD-12` and `X-03` exercise a Unicode filename and fail on raw-path
   equality.

The suite sends only discovery/list/get/read and expected-failure requests. It
never mutates catalog state. When `MCP_TOKEN` is set, the token is read from the
environment, never printed, and never written to a report.

## Provenance and safety

- Fixture content is public, synthetic, and deterministic (three skills, seven
  exposed files, one hidden file that must never appear).
- The fixture uses the pinned `@modelcontextprotocol/server@2.4.0` and
  `zod@4.6.7`. It is not the product implementation and must never be deployed
  or bundled into the Worker.
- No credentials, live accounts, network callbacks, or infrastructure changes
  are used.

## Local evidence

Recorded on the merged Revision 7 base
`737dd0754304764cf8bc7a945c083a666faba71a` (2026-11-27, Node `24.18.0`):

| Layer                          | Command                                        | Result                                       |
| ------------------------------ | ---------------------------------------------- | -------------------------------------------- |
| Wire suite, fixture            | `tests/protocol/run-local.sh`                  | 39 pass, 0 fail, 1 optional skip (`AUTH-01`) |
| Official client, fixture       | `tests/protocol/run-local.sh`                  | 17 pass, 0 fail (modern 10, legacy 7)        |
| Vitest wrapper                 | `pnpm test -- tests/protocol/protocol.test.ts` | 1 file, 2 tests passed                       |
| Runtime endpoint, local Worker | `MCP_TEST_URL=... tests/protocol/run-local.sh` | Separate release runtime suites in CI        |

The full evidence record is
[`docs/acceptance/V010-008-protocol-verification.md`](../../docs/acceptance/V010-008-protocol-verification.md).

## Release runtime coverage

The CI suite also runs `tests/worker.test.ts` against the release Worker in workerd with an isolated local OAuth grant, and `tests/catalog-runtime.test.ts` against the release SDK handler and generated catalog. These cover both protocol eras, paginated inventory, and fallback parity. The reference fixture serves one page and does not exercise the release catalog.
