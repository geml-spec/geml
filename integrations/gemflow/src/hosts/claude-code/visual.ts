// A visual drawn inline in the conversation (the visualize tool's widget):
// no file and no link of its own, so gemflow keeps it as a page that opens by
// itself, among the work item's artifacts. The widget is written for the
// host's look (its colour variables, its SVG classes, its icon font); the page
// gives it those in the light theme. Pure.

/** The tools that draw a widget inline: the visualize connector's, whatever the host calls the connector. */
export const isVisualTool = (tool: string): boolean => /(^|__)show_widget$/.test(tool);

/** The page's file name: the widget's title, made safe for any file system; `visual` when it has none. */
export function visualFileName(title: string): string {
  const safe = title.trim().replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return `${safe === "" ? "visual" : safe}.html`;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The colour ramps the widget's SVG classes name (c-gray, c-purple…): a fill, its stroke, a title and a subtitle. */
const RAMPS: Readonly<Record<string, readonly [string, string, string, string]>> = {
  purple: ["#EEEDFE", "#534AB7", "#3C3489", "#534AB7"], teal: ["#E1F5EE", "#0F6E56", "#085041", "#0F6E56"],
  coral: ["#FAECE7", "#993C1D", "#712B13", "#993C1D"], pink: ["#FBEAF0", "#993556", "#72243E", "#993556"],
  gray: ["#F1EFE8", "#5F5E5A", "#444441", "#5F5E5A"], blue: ["#E6F1FB", "#185FA5", "#0C447C", "#185FA5"],
  green: ["#EAF3DE", "#3B6D11", "#27500A", "#3B6D11"], amber: ["#FAEEDA", "#854F0B", "#633806", "#854F0B"],
  red: ["#FCEBEB", "#A32D2D", "#791F1F", "#A32D2D"],
};

const STYLE = [
  ":root{--surface-0:#f3f2ee;--surface-1:#f6f6f4;--surface-2:#fff;--surface-3:#fff;--border:rgba(0,0,0,.12);--border-strong:rgba(0,0,0,.22);--border-stronger:rgba(0,0,0,.4);",
  "--text-primary:#1f1e1d;--text-secondary:#5f5e5a;--text-muted:#888780;--radius:8px;--font-sans:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft Yahei',sans-serif;--font-mono:ui-monospace,Menlo,Consolas,monospace;--font-voice:Georgia,serif;",
  "--bg-accent:#E6F1FB;--text-accent:#185FA5;--border-accent:#378ADD;--bg-danger:#FCEBEB;--text-danger:#A32D2D;--border-danger:#E24B4A;--bg-success:#EAF3DE;--text-success:#3B6D11;--border-success:#639922;",
  "--bg-warning:#FAEEDA;--text-warning:#854F0B;--border-warning:#BA7517;--bg-pro:#EEEDFE;--text-pro:#534AB7;--border-pro:#7F77DD}",
  "body{margin:0;background:var(--surface-0);color:var(--text-primary);font-family:var(--font-sans);font-size:16px;line-height:1.7}",
  "main{max-width:720px;margin:0 auto;padding:24px 16px}h1.visual-title{font-size:18px;font-weight:500;margin:0 0 16px}",
  "button{font:inherit;background:transparent;border:.5px solid var(--border-strong);border-radius:var(--radius);padding:4px 12px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}",
  "svg .t{font-size:14px;fill:#1f1e1d}svg .ts{font-size:12px;fill:#5F5E5A}svg .th{font-size:14px;font-weight:500;fill:#1f1e1d}",
  ...Object.entries(RAMPS).map(([name, [fill, stroke, title, sub]]) =>
    `svg .c-${name} rect,svg .c-${name} circle,svg .c-${name} ellipse,svg rect.c-${name},svg circle.c-${name},svg ellipse.c-${name}{fill:${fill};stroke:${stroke}}svg .c-${name} .th,svg .c-${name} .t{fill:${title}}svg .c-${name} .ts{fill:${sub}}`),
].join("");

/** The page for a widget: its title as the heading, the widget as it was drawn, the look it was drawn for. */
export function visualPage(title: string, code: string): string {
  const name = title.trim() === "" ? "visual" : title.trim();
  return [
    "<!doctype html>", '<html lang="zh">', "<head>", '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${esc(name)}</title>`,
    '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/tabler-icons.min.css">',
    `<style>${STYLE}</style>`, "</head>", "<body>", "<main>", `<h1 class="visual-title">${esc(name)}</h1>`, code, "</main>", "</body>", "</html>", "",
  ].join("\n");
}
