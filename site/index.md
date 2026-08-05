---
layout: home
title: GEML — General Expressive Markup Language
---

<section class="hero">
  <div class="wrap">
    <img class="hero-logo" src="{{ '/assets/logo/geml-logo-dark.svg' | relative_url }}" alt="GEML">
    <p class="hero-tagline">A plain-text markup language that people and AI agents can write in the same document.</p>
    <p class="hero-sub">One block syntax carries everything — code, tables, diagrams, math, prose. Every block has an <code>#id</code>, so an agent rewrites <em>exactly one piece</em> instead of the whole file, every reference is checked at build time, and a bad edit rolls back on its own.</p>
    <div class="hero-actions">
      <a class="btn btn-primary" href="{{ '/playground/' | relative_url }}">Try it in the Playground</a>
      <a class="btn" href="https://github.com/{{ site.repository }}/blob/main/spec/GEML-spec.md">Read the spec</a>
      <a class="btn" href="https://github.com/{{ site.repository }}">GitHub</a>
    </div>
    <div class="hero-badges">
      <a href="https://www.npmjs.com/package/@geml/geml"><img src="https://img.shields.io/npm/v/%40geml%2Fgeml?label=npm" alt="npm"></a>
      <a href="https://github.com/{{ site.repository }}/actions/workflows/ci.yml"><img src="https://github.com/{{ site.repository }}/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
      <a href="https://github.com/{{ site.repository }}/blob/main/spec/GEML-spec.md"><img src="https://img.shields.io/badge/spec-1.0-brightgreen.svg" alt="spec 1.0"></a>
      <a href="https://github.com/{{ site.repository }}/blob/main/LICENSE"><img src="https://img.shields.io/badge/code-MIT-blue.svg" alt="code MIT"></a>
    </div>
  </div>
</section>

<section class="section section-manifesto" id="manifesto">
  <div class="wrap">
    <p class="section-kicker">The Doc-as-a-Base Manifesto</p>
    <h2 class="manifesto-head">Documents no longer need just a format.<br>They need a set of verbs.</h2>
    <p class="section-lede">Just as <a href="https://www.ics.uci.edu/~fielding/pubs/dissertation/top.htm">REST</a> gave scattered resources one naming scheme (the URI) and one shared set of verbs, <strong>Doc-as-a-Base</strong> gives every block of a document one naming scheme (<code>#id</code>) and one shared set of verbs (<code>get</code> / <code>set</code> / <code>add</code> / <code>delete</code>).</p>
    <p>A document that is still plain text, but comes with its own verbs: every block has a name and can be fetched alone; references are verified, and a broken one turns the build red; an embed is a lookup, not a copy; a revert rolls back one block instead of redoing the whole page. It is the <strong>base</strong> of every deliverable — <code>.md</code> and <code>.html</code> are views projected from it.</p>

    <p class="manifesto-values-head">In the new paradigm, we value</p>
    <ul class="value-list">
      <li><strong>Addressing by block</strong><span>over reading and writing whole documents</span></li>
      <li><strong>References that fetch</strong><span>over copy and paste</span></li>
      <li><strong>Errors at build time</strong><span>over silent rot</span></li>
      <li><strong>Rolling back one block</strong><span>over redoing the whole page</span></li>
    </ul>

    <div class="manifesto-actions">
      <a class="btn btn-primary" href="https://github.com/{{ site.repository }}/blob/main/docs/MANIFESTO.md">Read the manifesto</a>
      <a class="btn" href="https://github.com/{{ site.repository }}/blob/main/docs/MANIFESTO_CN.md">中文版</a>
    </div>
  </div>
</section>

<section class="section" id="why-now">
  <div class="wrap">
    <p class="section-kicker">Why now</p>
    <h2>Because the reader has changed</h2>
    <p class="section-lede">For decades a text was optimized either for human reading (Markdown, Word) or for machine parsing (JSON, Schema). In the LLM era, humans and agents <strong>co-read, co-author, and rewrite</strong> the same document for the first time.</p>
    <p>The old ways break down: every time we provide context or prompts, we manufacture copies. The engineering source of truth gets duplicated, fragmented, and eventually drifts away. A copy is drift from the moment it is made.</p>
    <p class="blog-pointer">📖 Read the full argument on the blog: <a href="{{ '/blog/2026/08/03/why-do-we-need-a-new-text-format-in-the-era-of-llms/' | relative_url }}">"Why Do We Need a New Text Format in the Era of LLMs?"</a> · <a href="{{ '/blog/2026/08/03/why-do-we-need-a-new-text-format-in-the-era-of-llms_CN/' | relative_url }}">中文版</a></p>
    <p>To solve this, the format carrying the text has to provide four capabilities <em>at the syntax level</em>:</p>
    <div class="feature-grid">
      <div class="feature">
        <span class="feature-num">01</span>
        <h3>Block-level addressing</h3>
        <p>Every block has a unique <code>#id</code>. We no longer address just the whole file.</p>
      </div>
      <div class="feature">
        <span class="feature-num">02</span>
        <h3>Reference-based projection</h3>
        <p>Assemble context by looking values up, not copying them — <code>=== embed</code>.</p>
      </div>
      <div class="feature">
        <span class="feature-num">03</span>
        <h3>Build-time verification</h3>
        <p>A broken reference is a build error, not a silent 404 found later.</p>
      </div>
      <div class="feature">
        <span class="feature-num">04</span>
        <h3>Block-level revert</h3>
        <p>Roll back one block, independent of Git, via a <code>.gemlhistory</code> sidecar.</p>
      </div>
    </div>
  </div>
</section>

<section class="section section-alt" id="format">
  <div class="wrap">
    <p class="section-kicker">The format in 1 minute</p>
    <h2>One shape, every kind of content</h2>
    <p class="section-lede">A block is <code>=== type [attributes]</code> … <code>===</code>. Only the <code>type</code> — and how its body is read — changes.</p>

    <div class="example-grid">
      <div class="example-copy">
        <h3>Typed blocks</h3>
        <p>Code is a block. So are tables, diagrams, math, callouts, even metadata — and a run of prose can be one too (<code>=== text</code>), whenever you want it addressable. The shape is the same every time, which makes the language easy enough to learn that it's hard to get wrong.</p>
        <p>The type decides how the body is read: <strong>raw</strong> (verbatim — <code>code</code>, <code>diagram</code>, <code>math</code>, <code>table</code>), <strong>flow</strong> (parsed prose — <code>note</code>, <code>text</code>), or <strong>data</strong> (one <code>key=val</code> per line — <code>meta</code>).</p>
      </div>
      <div class="example-code">
{% highlight text %}
=== code {#hello lang=python}
print("hi")
===

=== note {.intro}
Prose with *emphasis* and a
[[#budget]] reference.
===

=== meta
title = "Budget plan"
===
{% endhighlight %}
      </div>
    </div>

    <div class="example-grid" style="margin-top:44px">
      <div class="example-code">
{% highlight text %}
=== table {#fy25 format=csv header=1
  compute="FY [%.1f] = Q1+Q2+Q3+Q4"
  summary="Segment = 'Total';
           FY [%.1f] = sum(FY)"}
Segment,  Q1, Q2, Q3, Q4
Cloud,     8, 10, 12, 14
Platform,  5,  6,  7,  9
===
{% endhighlight %}
      </div>
      <div class="example-copy">
        <h3>Tables compute</h3>
        <p>Write a table visually with pipes, or as CSV data with <strong>computed columns</strong> and a <strong>summary row</strong> — both describe the same model. <code>compute</code> runs arithmetic per row; <code>summary</code> adds a foot row from <code>sum / avg / min / max / count</code>.</p>
        <p>A chart can then bind straight to that table — <code>data=#fy25</code> — so there is a single source of truth and the column references are checked at build time.</p>
      </div>
    </div>

    <div class="example-grid" style="margin-top:44px">
      <div class="example-copy">
        <h3>Embeds — reference, don't copy</h3>
        <p>One block can stand for another, in the same document by <code>#id</code> or across documents by <code>src=other.geml#id</code>, and renders that block's <strong>current</strong> state in place. The body stays empty; the target lives in <code>src=</code>.</p>
        <p>If the target goes missing, <code>geml check</code> fails the build — a reference is a <em>lookup</em>, not a signpost.</p>
      </div>
      <div class="example-code">
{% highlight text %}
=== embed {src=#fy25}
===

=== embed {src=spec.geml#grammar}
===
{% endhighlight %}
      </div>
    </div>
  </div>
</section>

<section class="section" id="whats-different">
  <div class="wrap">
    <p class="section-kicker">What's different</p>
    <h2>Four capabilities, one plain-text format</h2>
    <p class="section-lede">Each capability has mature solutions in its own field. What's unusual is meeting all four at once, in plain text.</p>
    <div class="table-scroll">
      <table>
        <thead>
          <tr><th>Family</th><th>Addressable</th><th>Projectable</th><th>Verifiable</th><th>History</th></tr>
        </thead>
        <tbody>
          <tr><td>Word / Google Docs</td><td>❌</td><td>❌</td><td>❌</td><td>⚠️ platform-side</td></tr>
          <tr><td>Markdown / AsciiDoc</td><td>⚠️ anchors only</td><td>⚠️ breaks silently</td><td>❌</td><td>❌ external git</td></tr>
          <tr><td>JSON / XML</td><td>✔️</td><td>⚠️ XML only</td><td>✔️ external tooling</td><td>❌ external git</td></tr>
          <tr class="row-geml"><td><strong>GEML</strong></td><td><strong>✔️ <code>#id</code> per block</strong></td><td><strong>✔️ <code>embed</code></strong></td><td><strong>✔️ build error</strong></td><td><strong>✔️ <code>.gemlhistory</code></strong></td></tr>
        </tbody>
      </table>
    </div>
    <p class="table-note">Markdown owns the mainstream surfaces, so GEML positions itself as the <strong>editing source of truth</strong>, not the delivered artifact — project one way with <code>geml &lt;file&gt; --to md|html</code> and ship <code>.md</code> or <code>.html</code> as before. Collaboration, not lock-in. <em>(Projection is lossy: block ids and table-bound charts don't survive it.)</em></p>

    <h3 style="margin-top:36px">Design boundaries — GEML stays small on purpose</h3>
    <ul class="capability-list">
      <li><strong>No raw-HTML escape hatch</strong> — semantics stay portable, tied to no backend or renderer.</li>
      <li><strong>Hosts external diagram DSLs</strong> (Mermaid, Graphviz, D2, …) rather than inventing one.</li>
      <li><strong>Tables compute, but aren't a spreadsheet engine</strong> — per-row formulas and aggregates, not cell addressing or macros.</li>
      <li><strong>ATX headings only</strong> — no setext, no <code>---</code> frontmatter, no thematic-break guesswork.</li>
    </ul>
  </div>
</section>

<section class="section section-alt" id="agents">
  <div class="wrap">
    <p class="section-kicker">With an LLM</p>
    <h2>Written and edited by models — precisely</h2>
    <p class="section-lede">To change one thing, an agent needn't re-read and re-emit the whole document: it addresses a single block by id, then validates.</p>

{% highlight sh %}
npm i -g @geml/geml                       # the `geml` command (Node 22+)
geml get    doc.geml '#hello'             # print ONE block by name
geml set    doc.geml '#license' --in -    # replace a block from stdin
geml add    doc.geml --after '#intro' --in snippet.geml
geml rename doc.geml '#old' '#new'        # rename an id + every reference to it
geml revert doc.geml '#plan' --rev -1     # roll ONE block back
geml check  doc.geml                      # validate: diagnostics + exit code
{% endhighlight %}

    <p>Every mutation writes the whole updated document — in place for a file, to stdout for <code>-</code> — and each is re-parsed before the write and refused if it would break the document.</p>

    <div class="feature-grid">
      <div class="feature">
        <h3>An MCP server ships with the package</h3>
        <p>Your agent edits one block at a time instead of rewriting files. A write is parsed <em>before</em> it reaches disk and refused with diagnostics if it would break the document; every write first records a <code>.gemlhistory</code> revision, so a bad edit is both prevented and undoable.</p>
      </div>
      <div class="feature">
        <h3>One command for Claude Code</h3>
        <p><code>npx -y @geml/geml skill install</code> installs the authoring skill, the CLI, and the user-scope MCP registration. For any other model, paste the primer from the README and run <code>geml check</code> on the output for a hard pass/fail.</p>
      </div>
    </div>
  </div>
</section>

<section class="section" id="code-graph">
  <div class="wrap">
    <p class="section-kicker">A gift for programmers</p>
    <h2>Your whole codebase's call graph, written as GEML</h2>
    <p class="section-lede">A demanding test of one primitive: <code>geml codemap build</code> lays a call graph out as a tree of GEML documents — every method an <code>#id</code> block, with <code>#calls</code> / <code>#called-by</code> edges both ways.</p>
    <p>The <strong>downstream chain</strong> (what a method calls) for troubleshooting, the <strong>upstream chain</strong> (who calls it) for blast radius — visible in a second, queryable from the shell or by an agent.</p>

{% highlight sh %}
geml codemap build     # detect languages -> index -> one merged graph
geml codemap serve     # opens your browser on the graph
{% endhighlight %}

    <p class="table-note">Scale is measured, not promised: on Apache Flink — <strong>13,585 Java files, ~81,000 methods, 266,821 call edges</strong> — the plain-text data tables still open and query instantly. TS/JS needs zero setup; other languages take one <a href="https://docs.joern.io/installation">Joern</a> download.</p>
    <a class="link-more" href="https://github.com/{{ site.repository }}/blob/main/README.md#code-graph">Read more in the README →</a>
  </div>
</section>

<section class="section section-alt" id="maturity">
  <div class="wrap">
    <p class="section-kicker">Ecosystem &amp; maturity</p>
    <h2>Small and young — but stable</h2>
    <p class="section-lede"><strong>Spec 1.0</strong> is released and usable for real documents, with a strict conformance suite, a reference implementation that passes it, and an open proposal process.</p>
    <ul class="capability-list">
      <li><strong>Self-hosting</strong> — the specification itself is written in GEML and parsed clean on every test run.</li>
      <li><strong>A conformance suite</strong> a second, independently-written parser must reproduce case for case — two implementations agreeing is what keeps subtle rules from drifting.</li>
      <li><strong>600+ checks</strong> in <code>npm test</code>, coverage CI-gated at ≥95% lines / statements / functions / branches.</li>
      <li><strong>"Stable" means</strong> the rules already in 1.0 won't shift under you; a breaking change bumps the spec version and ships with updated conformance cases.</li>
    </ul>
    <p class="table-note"><strong>Two honest caveats.</strong> No mainstream surface renders <code>.geml</code> natively yet — the browser viewer, the CI Action, and one-way projections are how it travels today. And models are less fluent in it than in Markdown, because nothing was pre-trained on GEML at scale; the uniform block syntax and <code>--json</code> diagnostics let an agent check and repair its own output, but the starting fluency really is lower.</p>
    <a class="link-more" href="https://github.com/{{ site.repository }}/blob/main/README.md#maturity">Where a .geml file can land →</a>
  </div>
</section>

<section class="section" id="hands-on">
  <div class="wrap">
    <p class="section-kicker">Get hands-on</p>
    <h2>Three ways in</h2>
    <div class="steps">
      <div class="step">
        <h3>1. Try it live</h3>
        <p>Edit on the left, rendered on the right, and the build verdict flips red the moment a reference breaks. No install, nothing to read first.</p>
        <a class="link-more" href="{{ '/playground/' | relative_url }}">Open the Playground →</a>
      </div>
      <div class="step">
        <h3>2. Run it locally</h3>
{% highlight sh %}
npm i -g @geml/geml
geml check doc.geml
{% endhighlight %}
        <p>Or point it at your own repo with <code>geml codemap build</code>.</p>
      </div>
      <div class="step">
        <h3>3. Read the grammar</h3>
        <p>The full spec is normative and short enough to read in a sitting.</p>
        <a class="link-more" href="https://github.com/{{ site.repository }}/blob/main/spec/GEML-spec.md">Specification →</a>
      </div>
    </div>
  </div>
</section>

<section class="section section-alt section-blog-teaser">
  <div class="wrap">
    <p class="section-kicker">From the blog</p>
    <h2>Latest writing</h2>
    <ul class="post-grid">
      {% assign latest = site.posts | where_exp: "p", "p.lang != 'zh'" | first %}
      {% if latest %}
      {% assign words = latest.content | number_of_words %}
      {% assign read_min = words | divided_by: 200 | at_least: 1 %}
      <li class="post-card">
        <a class="post-card-link" href="{{ latest.url | relative_url }}">
          <span class="post-card-tag">{{ latest.category | default: "Article" }}</span>
          <h3 class="post-card-title">{{ latest.title }}</h3>
          <p class="post-card-excerpt">{{ latest.excerpt | strip_html | truncatewords: 32 }}</p>
          <p class="post-card-meta">{{ latest.date | date: "%B %-d, %Y" }} · {{ read_min }} min read</p>
          <span class="post-card-arrow">Read the article →</span>
        </a>
      </li>
      {% endif %}
    </ul>
    <p style="margin-top:20px">
      <a class="link-more" href="{{ '/blog/' | relative_url }}">All posts →</a> ·
      <a class="link-more" href="{{ '/blog/archive/' | relative_url }}">Archive &amp; topics →</a>
    </p>
  </div>
</section>
