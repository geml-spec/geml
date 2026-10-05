## What and why

<!-- One or two sentences. Link the issue (a spec change needs its `gep` issue). -->

## Checklist

- [ ] `npm test` is green in `geml-parser/` (and the CI jobs in
      [CONTRIBUTING.md](../CONTRIBUTING.md#what-ci-checks) that this change touches)
- [ ] A spec change lands with its conformance case in
      `geml-parser/test/conformance/` — never without one
- [ ] Every `.geml` document touched still passes `geml check`
- [ ] A changed document with a `_CN` (or English) twin is updated on both sides
