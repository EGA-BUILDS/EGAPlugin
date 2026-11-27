---
name: fixture-unicode-notes
description: Deterministic fixture skill with Unicode text and percent-encoded resource paths.
license: MIT
---

# Unicode fixture

Use this skill to verify that approved Unicode content survives catalog generation, MCP
transport and resource reads without normalization or substitution.

## Notes

- The reference path contains a non-ASCII filename.
- The asset contains multilingual text.
- Digests are computed over raw UTF-8 bytes.
