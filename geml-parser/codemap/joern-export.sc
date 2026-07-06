// geml-code-graph Joern export (P1, DESIGN §3.4).
// Runs INSIDE joern; emits raw method/call records as JSONL for adapters/joern.mjs.
//
// Parameters come from ENVIRONMENT VARIABLES, not --param: on Windows the
// joern.bat -> repl-bridge.bat hop re-tokenizes %* and cmd.exe treats `=` as a
// delimiter, so `--param k=v` never survives intact. Env vars pass through
// every layer on every OS:
//
//   GEML_SRC=/abs/path/to/src GEML_OUT=/abs/path/to/build/raw \
//     joern --script geml-parser/codemap/joern-export.sc
//
// Output:
//   <GEML_OUT>/methods.jsonl   one record per internal method
//   <GEML_OUT>/calls.jsonl     one record per call site, callees resolved by Joern
//
// Identity: methods are keyed by fullName|signature|filename — the adapter
// mints anchors and stable ids from these; this script stays dumb on purpose.
import java.io.{File, PrintWriter}

@main def exec(): Unit = {
  val codeDir = sys.env.getOrElse("GEML_SRC", { System.err.println("GEML_SRC not set"); sys.exit(2) })
  val outDir = sys.env.getOrElse("GEML_OUT", { System.err.println("GEML_OUT not set"); sys.exit(2) })
  // GEML_LANG (optional): force a frontend in mixed-language repos, where
  // auto-detection may pick the majority language instead of the intended one.
  // Values are Joern's --language names: JAVASRC, NEWC, PYTHONSRC, JSSRC, …
  sys.env.get("GEML_LANG") match {
    case Some(lang) => importCode(inputPath = codeDir, projectName = "geml-code-graph", language = lang)
    case None       => importCode(inputPath = codeDir, projectName = "geml-code-graph")
  }

  def esc(s: String): String =
    s.replace("\\", "\\\\").replace("\"", "\\\"")
     .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
  def jstr(s: String): String = "\"" + esc(s) + "\""

  new File(outDir).mkdirs()

  val skipName = (n: String) => n == "<global>" || n.startsWith("<operator>") || n.startsWith("<clinit>")

  // ---- methods ----
  val mOut = new PrintWriter(new File(outDir, "methods.jsonl"), "UTF-8")
  cpg.method.filter(m => !m.isExternal && !skipName(m.name)).foreach { m =>
    mOut.println(
      s"""{"name":${jstr(m.name)},"fullName":${jstr(m.fullName)},"signature":${jstr(m.signature)},""" +
      s""""file":${jstr(m.filename)},"lineStart":${m.lineNumber.map(_.toString).getOrElse("null")},""" +
      s""""lineEnd":${m.lineNumberEnd.map(_.toString).getOrElse("null")}}"""
    )
  }
  mOut.close()

  // ---- calls ----
  // For each call site inside an internal method: Joern-resolved callees.
  // Several internal callees = dispatch candidates (the adapter keeps them ALL,
  // per the "never force a single candidate" red line). No internal callee =
  // unresolved from the graph's point of view (external / pointer call).
  // Operator calls are noise (arithmetic, casts, field access) EXCEPT
  // <operator>.pointerCall — a function-pointer invocation is a real dispatch
  // site the graph cannot resolve statically, so it must surface as an
  // unresolved call (blind spots are shown, not hidden). Its readable label is
  // the source expression itself.
  val cOut = new PrintWriter(new File(outDir, "calls.jsonl"), "UTF-8")
  cpg.call.filterNot(c => c.name.startsWith("<operator>") && c.name != "<operator>.pointerCall").foreach { c =>
    val caller = c.method
    if (!caller.isExternal && !skipName(caller.name)) {
      val callees = c.callee.l
      val internal = callees.filter(m => !m.isExternal && !skipName(m.name))
      val tos = internal.map(m =>
        s"""{"fullName":${jstr(m.fullName)},"signature":${jstr(m.signature)},"file":${jstr(m.filename)}}"""
      ).mkString("[", ",", "]")
      val label =
        if (c.name == "<operator>.pointerCall") c.code.takeWhile(_ != '\n').take(48)
        else c.name
      cOut.println(
        s"""{"callerFullName":${jstr(caller.fullName)},"callerSignature":${jstr(caller.signature)},""" +
        s""""callerFile":${jstr(caller.filename)},"name":${jstr(label)},""" +
        s""""line":${c.lineNumber.map(_.toString).getOrElse("null")},"callees":$tos}"""
      )
    }
  }
  cOut.close()

  println(s"geml-code-graph joern-export: done -> $outDir")
}
