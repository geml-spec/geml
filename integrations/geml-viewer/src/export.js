// The page a snapshot is handed to, because the page it came FROM cannot save it:
// raw.githubusercontent serves `Content-Security-Policy: … sandbox`, and a bare
// `sandbox` withholds `allow-downloads`. This document is chrome-extension://,
// so an ordinary blob download works and no `downloads` permission is needed.
(async () => {
  const id = new URLSearchParams(location.search).get("id");
  const said = document.getElementById("said");
  const r = await chrome.runtime.sendMessage({ type: "geml-export-take", id });
  if (!r || !r.ok) {
    said.textContent = (r && r.error) || "nothing to export";
    return;
  }
  document.getElementById("name").textContent = r.name;
  document.getElementById("md").textContent = r.md;

  if (r.untranslated.length > 0) {
    // Named, never silent: a half-translated file that does not say which half is
    // the artifact this whole feature exists to avoid producing by accident.
    const box = document.getElementById("warn");
    box.className = "warn";
    const head = document.createElement("strong");
    head.textContent = `${r.untranslated.length} section(s) are still in the source language:`;
    const ul = document.createElement("ul");
    for (const u of r.untranslated) {
      const li = document.createElement("li");
      li.textContent = `${u.src || "(this document)"} — ${u.why}`;
      ul.appendChild(li);
    }
    box.append(head, ul);
  }

  document.getElementById("save").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([r.md], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = r.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
  document.getElementById("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(r.md);
      said.textContent = "copied";
    } catch (e) {
      said.textContent = `could not copy: ${e && e.message ? e.message : e}`;
    }
  });
})();
