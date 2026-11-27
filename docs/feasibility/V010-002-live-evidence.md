# V010-002 live feasibility evidence

**V1-001 remains open.** This report records experiments against SPEC-001 Revision 6 at the released baseline `820ed0b17682fe3361321c7c59c3c3671472c7d1`. The [original feasibility report](V1-001-report.md) preserves the earlier local research. No feasibility sign-off or Phase B implementation has occurred.

## Architecture evaluated

The spike used the official TypeScript SDK server and client at 2.4.0, native `createMcpHandler`, a request-scoped `McpServer`, the SEP-2640 beta snapshot `c0705f9071caa539eeb2c9f5f2f77ac16b048ca6`, and one immutable build-generated `SkillSource`. The catalog used five-entry pages, complete raw-byte manifests, and shared content for native and fallback access. The experiment used Workers Free, Workers OAuth Provider 1.4.0, Wrangler 4.168.0 and the official Workers Vitest integration 1.9.2.

## Gate results

| Gate | Evidence                                                                                                                                                                                                                 | What remains                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1   | Workers Free subscriptions verified; clean deployed bundle 2112.14 KiB, 354.06 KiB gzip; deployment startup reported at 96 ms. Local startup profiling of the clean bundle recorded five runs at 130.2–185.1 ms elapsed. | Confirm complete final-candidate tooling evidence.                                                                                               |
| G2   | Earlier wire suite 40/40 across modern and legacy. Official SDK client verified 100 skills and 600 files on the clean live candidate. The final live candidate returned SDK error -32602 for malformed cursors.          | Verify the functional implementation in Phase B.                                                                                                 |
| G3   | Real owner OAuth connected through OpenCode with PKCE S256 and catalog read scope. Synthetic OAuth negatives passed 10/10 on an earlier version of the same disposable Worker.                                           | Real non-owner rejection and live audience and expiry enforcement.                                                                               |
| G4   | OpenCode and Hermes exercised fallback retrieval with matching SHA-256. Claude Code and Codex showed connection or tool discovery.                                                                                       | Native host activation remains unobserved. ChatGPT and T3 Code acceptance remain unverified. Retest applicable workflows on the final candidate. |
| G5   | Aggregate edge CPU p95 was 5.304 ms against the required 5 ms. Four measured warm cells exceeded the limit.                                                                                                              | Complete the cold and warm matrix and meet the unchanged target.                                                                                 |
| G6   | Private/no-store behavior observed for protected responses; revocation observed in one Cloudflare location.                                                                                                              | Multi-location revocation, historical URL protection on a known working route, rollback, and withdrawal.                                         |
| G7   | Independent review recomputed the CPU figures and withheld approval.                                                                                                                                                     | Verify the final candidate, complete disposable cleanup, and obtain owner approval.                                                              |

## Edge CPU

Clean deployed candidate `779ce39e-2779-4eb5-b663-9cd70a6b752d`, five entries per page. These warm p95 values use nearest rank over captured samples, in milliseconds.

| Skills | Discover | List | Get | Read | Search fallback |
| -----: | -------: | ---: | --: | ---: | --------------: |
|      1 |        3 |    5 |   4 |    3 |               9 |
|     10 |        4 |    5 |   3 |    3 |               4 |
|     50 |        3 |    6 |   3 |    5 |               6 |
|    100 |        3 |    5 |   5 |    4 |               7 |

Tail captured 774 of 1,000 warm requests, roughly 35–44 observations per cell. Aggregate Cloudflare telemetry recorded 1,116 requests and zero errors, with p50 2.055 ms, p95 5.304 ms and p99 12.867 ms. Successful observations above 10 ms are consistent with infrequent overage tolerance on Workers Free and do not establish headroom. The earlier 100-skill list-only warm run reported 4 ms p95 with 86 of 100 requests captured. The separate post-deploy warm-up reached 13 ms p95. The cold matrix captured 19 first-touch requests, insufficient for cold percentiles. Twelve warm cells for legacy initialize and the other two fallback tools were missing.

Live list profiles attributed 35.6–39.7% of the samples to Skills handling and serialization in the five- and ten-entry comparison. These were short captures of 45 and 63 samples. Local fallback profiles attributed most CPU to SDK dispatch, transport, validation and garbage collection. Precomputing search fields saved about 8 microseconds in the search callback but changed whole-request search CPU by only 0.2%, within run-to-run variation. The patch was not selected. The SDK trusted catalog reduced local list CPU but added directory-read and resource-list behavior and did not address the fallback paths. The next candidate keeps the custom immutable source and the five-entry cap.

## Client evidence

| Client                                   | Observed workflow                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Official SDK 2.4.0                       | Modern and legacy protocol, native catalog operations and integrity checks.                                              |
| OpenCode 2.4.2, DeepSeek V4.1 Flash High | Owner OAuth, search and file retrieval with matching digest. The exact deployment ID was not recorded for the owner run. |
| Hermes 0.23.4                            | Fallback skill and file retrieval with matching digest on the clean deployed candidate.                                  |
| Claude Code 2.1.167                      | Connection and tool discovery.                                                                                           |
| Codex CLI 0.172.0                        | Connection and tool discovery using legacy negotiation.                                                                  |
| ChatGPT and T3 Code                      | Acceptance unverified.                                                                                                   |

## Security and next candidate

Token-key deletion resulted in HTTP 401 after 44 seconds. Refresh returned invalid_grant after grant deletion and a 75-second wait. Both observations came from one location. The clean deployment returned 404 for the retired test-mint and test-revocation routes. Its test mint secret was deleted. The separate Hermes grant was revoked and its local file removed. See the cleanup inventory below for verification after the campaign.

## Final candidate and resumed benchmark

Worker version `ee26fab1-1591-46b9-9999-8051634f5130` reported the same ID through its Worker Version Metadata binding and response header. The uploaded bundle SHA-256 was `24a55a60528fc7598fc0dc2cde3451822a1ddbdd0b993f3b7f73173b31c0a834`. Wrangler reported 81 ms startup and a 2,114.75 KiB bundle (354.73 KiB gzip). The runtime rejected both retired test routes.

The authenticated campaign used a separate GitHub owner consent flow. The wire suite passed 40/40 checks covering both protocol eras, authorization, Origin, caching and malformed input. Malformed cursors returned JSON-RPC error `-32602`. The official SDK verified 100 skills and 600 files, and the modern-pinned run passed 6/6 checks. The unauthenticated campaign passed 9/9 checks, including the `private, no-store` challenge. Live non-owner, audience, expiry and distributed revocation evidence remain open. The focused local authorization suite passed five cases covering the owner, scope, audience and expiry checks. A second GitHub account is unavailable, so real non-owner OAuth rejection remains unverified.

The original warm run recorded only 321 of 3,200 measured CPU events and is insufficient for acceptance. The resumable run uses one request per second and correlates individual requests to CPU samples and the exact version. A valid measurement that exceeds 5 ms p95 is retained, and collection continues. Invalid identity, failed authorization, insufficient coverage or other measurement errors stop collection.

The first resumed cell, one-skill `server/discover`, captured 100 of 100 measured requests with zero errors. Nearest-rank CPU p50 was 3 ms, p95 6 ms, p99 10 ms, and maximum 20 ms. HTTP latency p50 was 74.743 ms and p95 101.178 ms. This cell misses the 5 ms target. The full warm matrix and attributable cold measurements remain pending. The owner subsequently directed that the campaign end. At conclusion no benchmark process was running. The checkpoint captured 2,498 of 2,500 measured invocations and recorded four p95 target misses across [25 completed warm cells](V010-002-warm-checkpoint.csv) out of 32, including all completed threshold failures. The log ends as the 100-skill list cell starts. That cell has no completion checkpoint and is excluded. CPU percentiles are nearest-rank. The CSV contains per-cell sample counts, coverage, errors, CPU maxima and HTTP latency percentiles. Full warm coverage and attributable cold measurements remain incomplete.

Revision 7 proposes moving incomplete production performance and live security acceptance to v0.3.0 and exhaustive real-client acceptance to v0.4.0. Historical review findings remain open where evidence is missing. No deferred check is recorded as passed. PR A requires independent review, verified disposable cleanup and owner adoption before merge.

### Cleanup after benchmark closure

| Resource                       | Cleanup evidence                                                                                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker and versions            | The retained negative-test bundle identifies its Worker as `egaplugin-v010-feasibility`. The retained deployment records identify `bc7cefcc-8b01-435b-9242-792c93931b25` as an earlier version of that Worker. Cloudflare returned HTTP 404 after deletion of the Worker. |
| Isolated OAuth KV              | Cloudflare confirmed the namespace was absent after deletion. Its disposable client registrations, access tokens and refresh grants were stored in that namespace.                                                                                                        |
| Test mint route and secret     | The final deployment returned 404 for the route. The deployment binding inventory excluded the test mint secret.                                                                                                                                                          |
| Local grant files              | The final browser-consent grant file and the Hermes test grant file were removed. The owner's OpenCode session was preserved.                                                                                                                                             |
| GitHub test OAuth app          | Owner-side deletion and verification remain open.                                                                                                                                                                                                                         |
| Temporary Cloudflare API token | Owner-side retirement and verification remain open.                                                                                                                                                                                                                       |

Cleanup remains partial. The repository contains summarized evidence and the checkpoint CSV. Raw logs and experimental bundles were excluded from this public PR.
