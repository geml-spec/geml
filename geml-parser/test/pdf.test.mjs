// End-to-end and unit tests for --to typst and --to pdf. Run with `npm test`.
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileTypstToPdf } from "../dist/render-pdf.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const CLI = "dist/cli.js";

function run(args, input) {
  const r = spawnSync(process.execPath, [CLI, ...args], { input, encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const SAMPLE_GEML = `=== meta
title = "PDF Export Test"
author = "GEML Suite"
===

# Overview {#overview}

This is a test document for PDF compilation.

## Features {#features}

=== math {#eq-pyth}
a^2 + b^2 = c^2
===

See @overview and @eq-pyth.

=== table {#metrics caption="Metrics"}
| Metric | Value |
|:-------|------:|
| Speed  | 100   |
| Memory | 20    |
===

Check @metrics.

=== note {.tip}
A helpful tip for testing.
===
`;

test("pdf: compileTypstToPdf in-process compiles typst to valid PDF buffer", () => {
  const typstSrc = `#set page(paper: "a4")\n= Test\nHello PDF world!`;
  const buf = compileTypstToPdf(typstSrc);
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 500);
  assert.equal(buf.subarray(0, 8).toString("ascii"), "%PDF-1.7");
});

test("pdf: CLI --to typst exports valid Typst code", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "geml-test-typst-"));
  try {
    const gemlPath = join(tempDir, "doc.geml");
    const typPath = join(tempDir, "doc.typ");
    writeFileSync(gemlPath, SAMPLE_GEML, "utf8");

    const r = run([gemlPath, "--to", "typst", "-o", typPath]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /wrote .*doc\.typ/);

    const typContent = readFileSync(typPath, "utf8");
    assert.match(typContent, /#set document\(title: "PDF Export Test"/);
    assert.match(typContent, /= Overview <overview>/);
    assert.match(typContent, /@overview/);
    assert.match(typContent, /@eq-pyth/);
    assert.match(typContent, /@metrics/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("pdf: CLI --to pdf generates valid PDF file with -o", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "geml-test-pdf-"));
  try {
    const gemlPath = join(tempDir, "doc.geml");
    const pdfPath = join(tempDir, "doc.pdf");
    writeFileSync(gemlPath, SAMPLE_GEML, "utf8");

    const r = run([gemlPath, "--to", "pdf", "-o", pdfPath]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /wrote .*doc\.pdf/);

    const pdfBytes = readFileSync(pdfPath);
    assert.ok(pdfBytes.length > 2000);
    assert.equal(pdfBytes.subarray(0, 8).toString("ascii"), "%PDF-1.7");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("pdf: CLI --to pdf defaults to <basename>.pdf when -o is omitted", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "geml-test-pdf-default-"));
  try {
    const gemlPath = join(tempDir, "sample.geml");
    const expectedPdfPath = join(tempDir, "sample.pdf");
    writeFileSync(gemlPath, SAMPLE_GEML, "utf8");

    const r = run([gemlPath, "--to", "pdf"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /wrote .*sample\.pdf/);

    const pdfBytes = readFileSync(expectedPdfPath);
    assert.ok(pdfBytes.length > 2000);
    assert.equal(pdfBytes.subarray(0, 8).toString("ascii"), "%PDF-1.7");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("pdf: CLI rejects unknown format and mentions typst and pdf", () => {
  const r = run(["-", "--to", "badfmt"], "# Test\n");
  assert.equal(r.code, 2);
  assert.match(r.err, /want json \| html \| md \| geml \| typst \| pdf/);
});

test("pdf: compileTypstToPdf throws on invalid Typst source", () => {
  assert.throws(() => {
    // Unclosed string literal or malformed macro call causes compilation failure
    compileTypstToPdf('#set page("unterminated');
  });
});

test("pdf: CLI reads from stdin and outputs typst to stdout", () => {
  const r = run(["-", "--to", "typst"], "# Stdin Test\nParagraph.\n");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /= Stdin Test/);
  assert.match(r.out, /Paragraph\./);
});

console.log(`${passed} pdf tests passed.`);
