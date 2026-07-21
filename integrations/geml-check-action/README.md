# GEML check — GitHub Action

Fail the build when a `.geml` document has an error: a dangling `[[#id]]`, a
broken cross-document link, a duplicate id, or any parse error. It is `geml
check` wired into CI — the check that keeps **AI-edited docs from silently
rotting**.

## Usage

```yaml
name: docs
on: [push, pull_request]

jobs:
  geml:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: geml-spec/geml/integrations/geml-check-action@main
        # with:
        #   files: "docs/**/*.geml README.geml"   # default: all tracked *.geml
        #   version: "latest"                       # default: latest (or pin, e.g. "1.2.2")
        #   root: "."                               # allow repo-relative ../ cross-doc refs
```

By default it checks every `.geml` file tracked in the repo and fails the job
(non-zero exit) the moment any file has an `error` diagnostic. Warnings do not
fail the build.

> Once this action gets its own repository (planned), the reference shortens to
> `uses: geml-spec/geml-check-action@v1`.

## Inputs

| Input     | Default          | Description                                                        |
|-----------|------------------|--------------------------------------------------------------------|
| `files`   | all tracked `*.geml` | Space-separated globs of `.geml` files to check.               |
| `version` | `latest`         | Version of the [`@geml/geml`](https://www.npmjs.com/package/@geml/geml) CLI to run. |
| `root`    | *(unset)*        | Directory to widen cross-document reference checking to (forwarded as `geml check --root`). Set `"."` to allow repo-relative `../` references between sibling directories; escapes past the root are still refused. Unset = each file resolves only within its own directory subtree. Requires a CLI version with `--root` (> 1.2.2). |

## What it runs

`npm install -g @geml/geml`, then `geml check <file>` for each target file.
`geml check` exits non-zero on any error diagnostic, which the action surfaces as
a GitHub `::error` annotation on the offending file and propagates as the job's
exit code.

## License

MIT.
