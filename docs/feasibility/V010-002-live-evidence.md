# V010-002 live feasibility evidence

**V1-001 remains open.** This report records experiments against SPEC-001 Revision 6 at the released baseline `820ed0b17682fe3361321c7c59c3c3671472c7d1`. The [original feasibility report](V1-001-report.md) preserves the earlier local research. No feasibility sign-off or Phase B implementation has occurred.

## Architecture evaluated

The spike used the official TypeScript SDK server and client at 2.4.0, native `createMcpHandler`, a request-scoped `McpServer`, the SEP-2640 beta snapshot `c0705f9071caa539eeb2c9f5f2f77ac16b048ca6`, and one immutable build-generated `SkillSource`. The catalog used five-entry pages, complete raw-byte manifests, and shared content for native and fallback access. The experiment used Workers Free, Workers OAuth Provider 1.4.0, Wrangler 4.168.0 and the official Workers Vitest integration 1.9.2.

## Gate results

| Gate | Evidence                                                                                                                                                                                                                 | What remains                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1   | Workers Free subscriptions verified; clean deployed bundle 2112.14 KiB, 354.06 KiB gzip; deployment startup reported at 96 ms. Local startup profiling of the clean bundle recorded five runs at 130.2–185.1 ms elapsed. | Record the final candidate's live startup and tooling evidence alongside its exact deployment identity.                                          |
| G2   | Earlier wire suite 40/40 across modern and legacy. Official SDK client verified 100 skills and 600 files on the clean live candidate. The next local candidate rejects malformed cursors with SDK error -32602.          | Rerun the affected protocol and catalog tests on the final exact deployment.                                                                     |
| G3   | Real owner OAuth connected through OpenCode with PKCE S256 and catalog read scope. Synthetic OAuth negatives passed 10/10 on a separate test deployment.                                                                 | Confirm final-version owner flow, real non-owner rejection, and live audience and expiry enforcement.                                            |
| G4   | OpenCode and Hermes exercised fallback retrieval with matching SHA-256. Claude Code and Codex showed connection or tool discovery.                                                                                       | Native host activation remains unobserved. ChatGPT and T3 Code acceptance remain unverified. Retest applicable workflows on the final candidate. |
| G5   | Aggregate edge CPU p95 was 5.304 ms against the required 5 ms. Four measured warm cells exceeded the limit.                                                                                                              | Complete the cold and warm matrix and meet the unchanged target.                                                                                 |
| G6   | Private/no-store behavior observed for protected responses; revocation observed in one Cloudflare location.                                                                                                              | Verify the final 401 header, multi-location revocation, historical URL protection on a known working route, rollback, and withdrawal.            |
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

Token-key deletion resulted in HTTP 401 after 44 seconds. Refresh returned invalid_grant after grant deletion and a 75-second wait. Both observations came from one location. The clean deployment returned 404 for the retired test-mint and test-revocation routes. Its test mint secret was deleted. The separate Hermes grant was revoked and its local file removed. Final disposable Worker, KV and OAuth app cleanup remains unverified.

The next candidate is local. It adds exact version metadata, opaque cursor handling, SDK invalid-parameter errors for malformed cursors, and independent owner, scope, audience and expiry checks. Its generated inventories matched all 966 files across the four synthetic catalogs. The focused runtime suite passed 12 tests. The offline final benchmark harness passed 23 self-tests and exercised all 32 operation-size cases locally. These checks supply no fresh live CPU measurements. The last private request for a disposable test grant was cancelled. The final authenticated campaign requires a fresh disposable grant or a separate browser consent flow that preserves the existing owner session.

The final campaign must tie every result to one exact deployed version, measure all eight operations at all four sizes, report actual CPU capture coverage and nearest-rank statistics, close the remaining authorization and security cases, and preserve sanitized independent review and cleanup evidence. Keep the 5 ms target. PR A and Phase B remain gated by SPEC-001.
