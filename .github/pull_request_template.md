## Goal and context

<!-- Link the approved work package issue (e.g., V1-001) and summarize the goal. -->

## Scope and non-goals

- **In scope:**
- **Out of scope:**

## Dependencies

- Depends on:

## Acceptance criteria

- [ ] Meets the exit gate in `docs/specs/SPEC-001.md`
- [ ] No premature work from future packages

## Test evidence

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run
```

## Security and architecture impact

- Secrets exposed? No
- Untrusted upstream code executed? No
- Infrastructure budget (SPEC-001 §2.3) respected? Yes
