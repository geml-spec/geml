// The page the background worker opens when the browser keeps this extension
// away from files on disk. No extension can turn "Allow access to file URLs" on
// for itself: the person flips it on the extension's details page. So the page
// says why, opens that details page, and shows whether the switch is on now,
// checking again whenever the person comes back to the tab.

const edge = /\bEdg\//.test(navigator.userAgent);
const lang = new URLSearchParams(location.search).get("lang") ?? navigator.language;
const zh = /^zh\b/i.test(lang);

const TEXT = zh
  ? {
      title: "让 GEML Viewer 打开本机的 .geml 文件",
      why: ["浏览器默认不让扩展读你磁盘上的文件。要看从磁盘打开的 ", ".geml", "（", "file:///…", "），请在扩展的详细信息页打开", "", "。"],
      toggle: edge ? "「允许访问文件 URL」" : "「允许访问文件网址」",
      open: "打开详细信息页",
      off: "现在：未开启",
      on: "现在：已开启。本机的 .geml 会直接渲染，可以关掉这页了。",
      web: ["网上的 .geml（", "https://", "）不需要这个权限。"],
    }
  : {
      title: "Let GEML Viewer open .geml files on this computer",
      why: ["The browser keeps extensions away from files on your disk until you allow it. To read a ", ".geml", " you open from disk (", "file:///…", "), turn on ", "", " on the extension's details page."],
      toggle: "Allow access to file URLs",
      open: "Open the details page",
      off: "Now: off",
      on: "Now: on. .geml files on this computer will render; you can close this tab.",
      web: [".geml files on the web (", "https://", ") render without this."],
    };

// Plain text and <code>/<b> nodes only: nothing here is parsed as HTML.
function fill(el, parts, bold) {
  el.textContent = "";
  parts.forEach((p, i) => {
    if (i === 5 && bold !== undefined) { const b = document.createElement("b"); b.textContent = bold; el.appendChild(b); }
    if (p === "") return;
    if (i % 2 === 1 && i !== 5) { const c = document.createElement("code"); c.textContent = p; el.appendChild(c); }
    else el.appendChild(document.createTextNode(p));
  });
}

document.documentElement.lang = zh ? "zh" : "en";
document.getElementById("title").textContent = TEXT.title;
document.title = TEXT.title;
fill(document.getElementById("why"), TEXT.why, TEXT.toggle);
fill(document.getElementById("web"), TEXT.web);
document.getElementById("open").textContent = TEXT.open;

function show(on) {
  document.getElementById("state").dataset.on = String(on);
  document.getElementById("said").textContent = on ? TEXT.on : TEXT.off;
}
show(false);

const api = globalThis.chrome?.extension?.isAllowedFileSchemeAccess;
if (api) {
  const check = () => chrome.extension.isAllowedFileSchemeAccess().then(show, () => {});
  check();
  // The switch is flipped in another tab: look again when this one is seen, and now and then while it is.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
  setInterval(() => { if (!document.hidden) check(); }, 1500);
  document.getElementById("open").addEventListener("click", () => {
    chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  });
}
