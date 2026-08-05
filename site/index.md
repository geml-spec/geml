---
layout: home
title: GEML — General Expressive Markup Language
---

<section class="hero">
  <div class="wrap">
    <img class="hero-logo" src="{{ '/assets/logo/geml-logo-light.svg' | relative_url }}" alt="GEML">
    <p class="hero-tagline">The markup language people and AI agents write in the same document.</p>
    <p class="hero-sub"><strong>One format, two readers.</strong> For people, plain text that reads clean; for agents, a <a href="https://github.com/{{ site.repository }}/blob/main/docs/MANIFESTO.md">"Doc-as-a-Base"</a> — addressable, verifiable, traceable, revertible.</p>
    <div class="hero-actions">
      <a class="btn btn-primary" href="https://geml-spec.github.io/geml/playground/">Try it in the Playground</a>
      <a class="btn" href="https://github.com/{{ site.repository }}/blob/main/spec/GEML-spec.md">Read the spec</a>
      <a class="btn" href="https://github.com/{{ site.repository }}">GitHub</a>
    </div>
    <div class="hero-badges">
      <a href="https://www.npmjs.com/package/@geml/geml"><img src="https://img.shields.io/npm/v/%40geml%2Fgeml?label=npm" alt="npm"></a>
      <a href="https://github.com/{{ site.repository }}/actions/workflows/ci.yml"><img src="https://github.com/{{ site.repository }}/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
      <a href="spec/GEML-spec.md"><img src="https://img.shields.io/badge/spec-1.0-brightgreen.svg" alt="spec 1.0"></a>
      <a href="https://github.com/{{ site.repository }}/blob/main/LICENSE"><img src="https://img.shields.io/badge/code-MIT-blue.svg" alt="code MIT"></a>
    </div>
  </div>
</section>

<section class="section section-example">
  <div class="wrap">
    <div class="example-grid">
      <div class="example-copy">
        <h2>One block, every kind of content</h2>
        <p>A <code>.geml</code> file is plain text — no renderer required to read it. Instead of a separate mini-syntax for tables, diagrams, math, and metadata, GEML carries every kind of content in one container: the <strong>typed block</strong>. Blocks carry a name, so the verbs have somewhere to land.</p>
      </div>
      <div class="example-code">
{% highlight text %}
=== code {#hello lang=python}
print("hi")
===
{% endhighlight %}
{% highlight sh %}
$ geml get doc.geml '#hello'   # by name, just this block
{% endhighlight %}
      </div>
    </div>
  </div>
</section>

<section class="section section-alt" id="why-now">
  <div class="wrap">
    <h2>Why now</h2>
    <p class="section-lede">Because <strong>the reader has changed</strong>.</p>
    <p>For decades, a text was optimized either for human reading (Markdown, Word) or for machine parsing (JSON, Schema). In the LLM era, humans and agents <strong>co-read, co-author, and rewrite</strong> the same document together for the first time. Every time we provide context or prompts, we manufacture copies — the engineering source of truth gets duplicated, fragmented, and eventually drifts away.</p>
    <p class="blog-pointer">📖 Read the full argument on the blog: <a href="/blog/2026/08/03/why-do-we-need-a-new-text-format-in-the-era-of-llms/">"Why Do We Need a New Text Format in the Era of LLMs?"</a></p>
    <p>To solve this crisis of copy explosion and broken dependencies, the format carrying the text must provide four core capabilities at the syntax level:</p>
    <ol class="capability-list">
      <li><strong>Block-level Addressing</strong> — every block has a unique <code>#id</code>; we no longer address just the whole file.</li>
      <li><strong>Reference-based Projection</strong> — assembling context by looking up values, not copying them (<code>embed</code>).</li>
      <li><strong>Build-time Verification</strong> — a broken link causes an immediate build error instead of decaying silently.</li>
      <li><strong>Block-level Revert</strong> — fine-grained, single-block history rollbacks, independent of Git.</li>
    </ol>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <h2>What's different</h2>
    <div class="table-scroll">
      <table>
        <thead>
          <tr><th>Family</th><th>Addressable</th><th>Projectable</th><th>Verifiable</th><th>History</th></tr>
        </thead>
        <tbody>
          <tr><td>Word / Docs</td><td>❌</td><td>❌</td><td>❌</td><td>⚠️</td></tr>
          <tr><td>Markdown / AsciiDoc</td><td>⚠️</td><td>⚠️</td><td>❌</td><td>❌</td></tr>
          <tr><td>JSON / XML</td><td>✔️</td><td>⚠️</td><td>✔️</td><td>❌</td></tr>
          <tr class="row-geml"><td><strong>GEML</strong></td><td><strong>✔️</strong></td><td><strong>✔️</strong></td><td><strong>✔️</strong></td><td><strong>✔️</strong></td></tr>
        </tbody>
      </table>
    </div>
    <p class="table-note">Markdown owns the mainstream surfaces, so GEML positions itself as the <strong>editing source of truth</strong>, not the delivered artifact — project one way with <code>geml &lt;file&gt; --to md|html</code> and ship <code>.md</code> or <code>.html</code> as before. Collaboration, not lock-in. See the <a href="https://github.com/{{ site.repository }}/blob/main/README.md#whats-different">full comparison</a> in the README.</p>
  </div>
</section>

<section class="section section-alt" id="code-graph">
  <div class="wrap">
    <h2>A gift for programmers — geml-code-graph</h2>
    <p>Point <code>geml codemap build</code> at any repo (TypeScript, Python, and more) and get a browsable call graph, addressable the same way as any other GEML document — <code>who calls X</code>, <code>what does X call</code>, traced impact paths, all queryable from the shell or by an agent.</p>
    <a class="link-more" href="https://github.com/{{ site.repository }}/blob/main/README.md#code-graph">Read more in the README →</a>
  </div>
</section>

<section class="section" id="hands-on">
  <div class="wrap">
    <h2>Get hands-on</h2>
    <div class="steps">
      <div class="step">
        <h3>1. Try it live</h3>
        <p>No install, nothing to read first — edit on the left, rendered on the right.</p>
        <a class="link-more" href="https://geml-spec.github.io/geml/playground/">Open the Playground →</a>
      </div>
      <div class="step">
        <h3>2. Run it locally</h3>
{% highlight sh %}
npm i -g @geml/geml   # Node 22+
geml check doc.geml   # validate a document
{% endhighlight %}
      </div>
      <div class="step">
        <h3>3. Read the grammar</h3>
        <p>The full spec is normative and short enough to read in a sitting.</p>
        <a class="link-more" href="https://github.com/{{ site.repository }}/blob/main/spec/GEML-spec.md">Spec (EN)</a> · <a class="link-more" href="https://github.com/{{ site.repository }}/blob/main/spec/GEML-spec_CN.md">规格 (中文)</a>
      </div>
    </div>
  </div>
</section>

<section class="section section-alt section-blog-teaser">
  <div class="wrap">
    <h2>From the blog</h2>
    <ul class="post-list post-list-compact">
      {% assign latest = site.posts | where_exp: "p", "p.lang != 'zh'" | first %}
      {% if latest %}
      <li class="post-item">
        <a class="post-item-title" href="{{ latest.url | relative_url }}">{{ latest.title }}</a>
        <p class="post-item-meta">{{ latest.date | date: "%B %-d, %Y" }}</p>
        <p class="post-item-excerpt">{{ latest.excerpt | strip_html | truncatewords: 35 }}</p>
      </li>
      {% endif %}
    </ul>
    <a class="link-more" href="/blog/">All posts →</a>
  </div>
</section>
