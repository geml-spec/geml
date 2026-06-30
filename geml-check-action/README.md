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
      - uses: geml-spec/geml-check-action@v1
        # with:
        #   files: "docs/**/*.geml README.geml"   # default: all tracked *.geml
        #   version: "1.0.0"                        # default: latest
```

By default it checks every `.geml` file tracked in the repo and fails the job
(non-zero exit) the moment any file has an `error` diagnostic. Warnings do not
fail the build.

> Until this action has its own repository, you can use it straight from the
> spec repo subdirectory:
> `uses: geml-spec/geml-spec/geml-check-action@main`

## Inputs

| Input     | Default          | Description                                                        |
|-----------|------------------|--------------------------------------------------------------------|
| `files`   | all tracked `*.geml` | Space-separated globs of `.geml` files to check.               |
| `version` | `latest`         | Version of the [`@geml/geml`](https://www.npmjs.com/package/@geml/geml) CLI to run. |

## What it runs

`npm install -g @geml/geml`, then `geml check <file>` for each target file.
`geml check` exits non-zero on any error diagnostic, which the action surfaces as
a GitHub `::error` annotation on the offending file and propagates as the job's
exit code.

## License

MIT.
