---
title: "Why Do We Need a New Text Format in the Era of LLMs?"
date: 2026-08-03
permalink: /blog/2026/08/03/why-do-we-need-a-new-text-format-in-the-era-of-llms/
lang: en
categories: [architecture, ai-agents]
tags: [geml, llm, doc-as-a-base, context-engineering]
lang_links:
  - label: 中文
    url: /blog/2026/08/03/why-do-we-need-a-new-text-format-in-the-era-of-llms_cn/
excerpt: "Everyone asks this question: we already have Markdown, AsciiDoc, JSON, and XML. Why invent a new format? Because the reader has changed — humans and agents now co-author the same document, and the old formats were never built for that."
---


# Why Do We Need a New Text Format in the Era of LLMs?

> **"In 2004 when Markdown was born, nobody needed a document that could be atomically rewritten by programs."**

---

## 1. Two Readers at the Same Writing Desk

For the past two decades, text formats have developed along a clear dichotomy:

* **Markup designed for human visual consumption** (e.g., Markdown, HTML): Prioritizes clean layout, effortless human readability, and seamless rendering into formatted pages.
* **Serialization formats designed for machine processing** (e.g., JSON, YAML, XML): Prioritizes structural rigor, static typing, ease of AST traversal, and machine persistence.

Under this division of labor, human engineers and computer programs operated in their respective domains without conflict.

However, with the rapid rise of Large Language Models (LLMs) and autonomous AI Agents embedded directly into software workflows and knowledge management, an irreversible shift has occurred: **Documents are no longer authored solely by humans for human readers. They are co-authored, incrementally modified, and continuously maintained by humans and AI Agents together.**

The AI Agent has become the document's **second reader**—and its frequent **co-author**.

When humans and machines sit down at the same writing desk, our traditional document infrastructure begins to fracture.

---

## 2. The Three Dilemmas of the Old Paradigms

### Dilemma 1: Markdown's "Full-Text Rewrite Tax" and Format Drift
Markdown was created in 2004 by John Gruber with a singular goal: allowing writers to format plain text intuitively and convert it easily to HTML. It was never architected to support atomic, programmatic in-place mutations.

Because Markdown lacks deterministic block boundaries and machine-identifiable primary keys, an Agent attempting to modify a single parameter or clause is typically forced into one of two fragile paths:
1. **Prompt-based instructions (*"Please only output the modified paragraph"*)**: Highly brittle. Over multi-turn interactions, it frequently leads to context misalignment and lost edits.
2. **Full-Text Regeneration (Full-Text Rewrite)**: To modify 10 words, the model is forced to ingest and regenerate 5,000 words.

In an Agent's iterative execution loop, full-text rewrites introduce severe penalties:
* **Context Budget Dilution**: The precious context window is consumed by unchanged characters, leaving less room for reasoning.
* **Format Drift and Hallucination**: Every full-text rewrite introduces another roll of the dice—risking broken formatting, omitted sections, or unintentional alterations to unrelated content.

### Dilemma 2: JSON / XML's "Syntactical Noise" and the Loss of Human Readability
If Markdown is too loose, why not store everything in JSON or XML?

The answer is obvious: **Syntactical wrapping is too heavy, and human cognitive load is too high.**  
Deeply nested braces, quotes, closing tags, and escape sequences deter human reading and direct editing, while consuming an unnecessarily high percentage of token budget.

### Dilemma 3: State Fragmentation and "Copy Drift"
In current Agent architectures, knowledge is scattered across disjointed stores: some in vector databases, some in short-term runtime memory, some in ad-hoc prompt templates, and some in copied-and-pasted Markdown snippets.

Software engineering holds an undeniable truth: **Copies begin drifting the moment they are born.**  
When redundant copies lack a single source of truth to anchor them, Agents inevitably operate on conflicting versions and fragmented data.

---

## 3. The Lesson of History: Documents Need Verbs, Not Just Formatting

In 2000, Roy Fielding introduced the **REST** architectural style in his doctoral dissertation. REST did not invent new networking hardware; its breakthrough was conceptual: **giving every scattered resource on the web a unique name (URI) and a uniform set of operational verbs (GET / POST / PUT / DELETE).** This simple convention laid the groundwork for modern web collaboration.

Today, facing countless paragraphs, rule definitions, system parameters, and conclusions scattered across documents, we encounter the exact same problem.

The solution to human-agent co-authoring is not another complex rich-text editor. It is bringing the philosophy of REST into plain text:

> **Doc-as-a-Base (Base of Truth)**:  
> Assign every logical block inside a document a unique name (`#id`), accompanied by standard operational verbs (`get` / `set` / `add` / `delete`).

---

## 4. The GEML Solution: Four Laws and Physical Isolation

To turn **Doc-as-a-Base** from a design philosophy into deterministic engineering, [GEML (geml-spec)](https://github.com/geml-spec/geml) establishes four foundational laws:

### 1. Addressing Law (寻址律)
> **Every structural block must have a stable machine key, readable and replaceable in isolation.**

GEML organizes plain text into Typed Blocks, each with an explicit `#id`.  
`get(id)` reads only that specific block; `set(id)` updates only that specific block. When an Agent modifies a section, the rest of the document is not only untouched—it is **not even loaded into the prompt context**.

> **"What isn't loaded cannot be broken — isolation, not discipline."**  
> Physical context isolation eliminates the token waste and hallucinations caused by full-text rewrites.

### 2. Projection Law (投射律)
> **Inclusion must be dynamic evaluation at the view layer, not static duplication.**

GEML natively supports modular embedding across blocks and documents. Defined once at the source, resolved dynamically upon consumption. This eliminates the maintenance burden of keeping duplicate copies in sync.

### 3. Validation Law (校验律)
> **Cross-block references must be verified at build time; bad writes are rejected before hitting disk.**

Write-time defense. If an Agent produces broken syntax or a dangling reference, the GEML parser rejects the write before it lands on disk, without waiting for manual human review.

### 4. Rollback Law (回退律)
> **When errors occur, roll back only the faulty block.**

With its companion `.gemlhistory` sidecar, GEML tracks block-level modification history. If an Agent introduces a bad edit, that specific block can be rolled back atomically without reverting the entire document.

> **"It's not that Git is bad; it's just not operating at this layer."**  
> Git governs file- and commit-level version control; GEML governs fine-grained, intra-document block rollbacks.

---

## 5. Boundary Declaration: What GEML Is NOT

The credibility of any rigorous specification rests on clearly stating what it does not claim:

1. **It is not a database**: Queries are O(N) stream scans without indexes; concurrent writes rely at most on file-level locks. GEML adopts database operational semantics (addressing, mutation, validation, rollback), not its runtime database properties.
2. **It does not replace vector stores or Agent runtime memory**: Vector databases handle semantic similarity search, and short-term memory manages conversational flow. GEML serves strictly as a **persistent, auditable, precisely addressable document base of truth**.
3. **It does not claim magical "Zero-Token Overhead"**: The `=== type {#id ...}` syntax carries lightweight structural cost. GEML practices **Syntax Austerity**—spending zero tokens on unnecessary styling or wrappers, reserving maximum context for actual content.
4. **Validation cannot fix poor writing**: It prevents structural corruption and broken references. If an Agent writes poor prose, the parser will not object.

---

## 6. Closing Thoughts

Addressing, projection, validation, and reversibility—each of these four capabilities is mature in its own domain: databases have primary keys, XML has XInclude, schemas provide validation, and Git tracks history.

**What is unusual is not any single one of these capabilities, but packing all four into human-readable plain text.**

Doc-as-a-Base is not about introducing a heavy runtime system. It is about establishing simple conventions that bring order to human-agent collaboration.

Give every paragraph a name. Give every modification a boundary.

---

* Repository: [github.com/geml-spec/geml](https://github.com/geml-spec/geml)  
* Full Specification & Manifesto: [The GEML Manifesto](https://github.com/geml-spec/geml/blob/main/docs/MANIFESTO.md)