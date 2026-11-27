# Protocol verification fixture (test-only)

This directory is a deterministic SEP-2640 reference server used to validate the
V010-008 protocol suite and to let integration run without a deployment. It is
**not** the product implementation and must never be deployed or bundled into
the Worker.

Derived from the validated V010-002 fixture at `5e72e96`, with two changes:

- `@modelcontextprotocol/client@2.4.0` is installed so the official-client layer
  can run from the same pinned dependency set.
- Every `skills/list` cursor is rejected with JSON-RPC `-32602` because the
  fixture serves one complete page and never issues a cursor. This exercises
  the malformed-cursor contract instead of silently ignoring input.

The fixture serves three public synthetic skills and seven approved files,
including a non-ASCII path and a dotfile that must never be exposed. It
implements modern (`2026-07-28`) and legacy (`initialize`) negotiation, the
skills extension, the three fallback tools, optional bearer auth, and
Streamable HTTP Origin validation. It makes no outbound requests.

Install and run:

```bash
npm install --no-audit --no-fund --ignore-scripts
node server.mjs --port 0 --allowed-origin https://allowed.example
```

The parent suite uses ephemeral ports and cleans up the process.
