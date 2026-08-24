---
layout: default
title: Privacy
permalink: /privacy/
---

# Privacy

**Nothing about you is collected.** GEML is a file format plus a command-line
tool. There is no account, no telemetry, no analytics, and no server that
belongs to this project.

## The CLI, the MCP server, and the editor integrations

`@geml/geml` runs entirely on your machine. It reads the files you point it at
and writes the files you tell it to write. It does not phone home — there is
nowhere for it to phone.

It touches the network in exactly two situations, both of them started by you:

- **Installing it.** `npm i -g @geml/geml` (or `npx -y @geml/geml`) downloads
  the package from the npm registry, which is npm's service, not ours.
- **`geml codemap build` on a TS/JS project.** It downloads the SCIP indexer
  it needs, once. For other languages you supply the indexer yourself and
  nothing is fetched.

Your documents, your code, and your `.gemlhistory` sidecars stay on your disk.
No document content is transmitted anywhere by anything in this project.

## The browser extension

GEML Viewer renders `.geml` files locally in your browser and collects nothing.
Its full policy is in
[`integrations/geml-viewer/PRIVACY.md`](https://github.com/geml-spec/geml/blob/main/integrations/geml-viewer/PRIVACY.md).

## This website

These pages are static files served by **GitHub Pages**. This project sets no
cookies and embeds no analytics, ad, or tracking scripts. GitHub operates the
hosting and may log requests under
[its own privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).

## Issues and discussions

If you open an issue, a discussion, or a pull request, that happens on GitHub
under your GitHub account and is public. What you write there is what we see;
we ask for nothing else.

## Changes

If any of the above ever stops being true, this page changes first — and
because it lives in the repository, the change is in the git history.

Questions: <https://github.com/geml-spec/geml/issues>
