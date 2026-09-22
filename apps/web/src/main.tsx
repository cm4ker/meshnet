import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { goBack } from "./lib/back.js";
import { autoConnect, connectWith, disconnect, getLink } from "./lib/link.js";
import { isCapacitor } from "./lib/platform.js";
import { session } from "./lib/session.js";
import { connectors } from "./transports/index.js";
import { initTheme } from "./theme/store.js";
import { initTextSize } from "./theme/textSize.js";
import "./styles.css";

// For the console, and for driving the shell from a test rig: the session,
// the link and the connectors, under one name. Android's shell calls `back`
// on its Back button (MainActivity).
Object.assign(window, { meshnet: { session, getLink, connectWith, disconnect, connectors, back: goBack } });

// Before the first render, so the page never paints in one palette or one text size and resolves
// into another.
initTheme();
initTextSize();

// In the phone app the page is the whole app, laid out to the screen, and a
// pinch that zooms it only leaves it scrolling sideways. The same cap stops
// iOS zooming in on a field it thinks too small to type in. A browser tab
// keeps its zoom.
if (isCapacitor()) {
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (viewport) viewport.content += ", maximum-scale=1, user-scalable=no";
}

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
