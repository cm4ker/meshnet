import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { autoConnect, connectWith, disconnect, getLink } from "./lib/link.js";
import { session } from "./lib/session.js";
import { connectors } from "./transports/index.js";
import { initTheme } from "./theme/store.js";
import "./styles.css";

// For the console, and for driving the shell from a test rig: the session,
// the link and the connectors, under one name.
Object.assign(window, { meshnet: { session, getLink, connectWith, disconnect, connectors } });

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
