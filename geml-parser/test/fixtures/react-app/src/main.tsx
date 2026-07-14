import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ThemeProvider } from "./context/ThemeContext";

// Module-scope render: the <App /> reference below has NO enclosing function,
// so it cannot be attributed to a caller — a pinned (documented) limitation.
const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  );
}
