import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { autoConnect } from "./lib/link.js";
import { initTheme } from "./theme/store.js";
import "./styles.css";

// Before the first render, so the page never paints in one palette and resolves into another.
initTheme();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The last radio, if it can be reached without a chooser. Not awaited: the
// connect screen shows the attempt.
void autoConnect();
