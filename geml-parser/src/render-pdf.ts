// Typst to PDF compiler interface.
//
// In-process compilation via @myriaddreamin/typst-ts-node-compiler (WASM/Rust native binding),
// with graceful fallback to system `typst` CLI when available.

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface PdfCompileOptions {
  workspace?: string;
  inputs?: Record<string, string>;
}

export function compileTypstToPdf(typstSource: string, opts: PdfCompileOptions = {}): Buffer {
  let nodeCompilerErr: unknown;

  // 1. Try in-process Node compiler (@myriaddreamin/typst-ts-node-compiler)
  try {
    const req = createRequire(import.meta.url);
    const { NodeCompiler } = req("@myriaddreamin/typst-ts-node-compiler");
    if (NodeCompiler) {
      const compiler = NodeCompiler.create({
        workspace: opts.workspace,
        inputs: opts.inputs,
      });
      const res = compiler.pdf({ mainFileContent: typstSource });
      if (res && Buffer.isBuffer(res)) {
        return res;
      }
    }
  } catch (err) {
    nodeCompilerErr = err;
  }

  // 2. Fallback to system typst CLI if available on PATH
  try {
    const tempDir = mkdtempSync(join(tmpdir(), "geml-typst-"));
    const typPath = join(tempDir, "document.typ");
    const pdfPath = join(tempDir, "document.pdf");
    writeFileSync(typPath, typstSource, "utf8");

    const res = spawnSync("typst", ["compile", typPath, pdfPath], {
      cwd: opts.workspace ?? process.cwd(),
      timeout: 30_000,
    });

    if (res.status === 0) {
      const pdfBytes = readFileSync(pdfPath);
      try {
        unlinkSync(typPath);
        unlinkSync(pdfPath);
      } catch {
        // ignore cleanup error
      }
      return pdfBytes;
    }
  } catch {
    // typst CLI not found or failed
  }

  // 3. Neither engine succeeded
  const detail = nodeCompilerErr ? ` (${(nodeCompilerErr as Error).message})` : "";
  throw new Error(
    `PDF compilation requires @myriaddreamin/typst-ts-node-compiler or the typst CLI on PATH${detail}. ` +
    `You can also export Typst source with \`--to typst\` and compile externally.`
  );
}
