# Agent guidance for EGAPlugin

1. Read [SPEC-001 Revision 6](docs/specs/SPEC-001.md) before implementation. It is the architectural authority. Work on one approved package at a time, in §9 order. Respect the infrastructure budget in §2.3.
2. Use MCP SDK v2 exclusively. Before changing MCP code, read the relevant official SDK v2 documentation and implementation skills listed in §11. Verify the public APIs against the exact pinned dependency release and reuse SDK behavior.
3. Use strict TypeScript, functional-first modules, and native platform APIs. Validate external inputs at trust boundaries. Avoid unsafe casts and unnecessary abstractions. Keep runtime dependencies minimal and justify every addition.
4. Follow the public repository and execution rules in §6. Keep secrets and private content out of Git, logs, and bundles. Never execute untrusted upstream scripts or hooks.
5. Work through a PR. Run the baseline checks in §7.2 and the applicable verification layers in §12. Record reproducible evidence, including versions, commands, outcomes, and open items. Request independent review of the actual diff and resolve blocking findings before approval.
6. Stop and report any conflict with SPEC-001 or any failed security, compatibility, or feasibility gate. Obtain explicit owner authorization before provisioning infrastructure or deploying.
