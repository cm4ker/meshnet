/**
 * What Back does, wherever it comes from: Android's button or gesture, a
 * browser's Back, a mouse's back key. One step each time, and the same step
 * the screen's own arrow or close button would take:
 *
 * 1. the topmost thing laid over the screen goes: a dialog, a sheet, a menu,
 *    the palette, the map's list pulled up;
 * 2. else the screen on top of the section closes;
 * 3. else the node picked on the map is let go;
 * 4. else Mesh and Radio go back to Chats, as Android's own apps return to
 *    their first tab.
 *
 * Only at the chat list, with nothing open, is there no step left, and the
 * app leaves. Android's shell asks `goBack` directly (MainActivity), so no
 * WebView history is involved there. A browser and the desktop shell only
 * have their history: while there is a step to take, one entry stands guard
 * above the page, and taking it takes the step instead of leaving the page.
 */

import { useEffect, useRef } from "react";
import { back, focusOnMap, getNav, goSection, subscribeNav } from "./nav.js";
import { isCapacitor } from "./platform.js";

interface Layer {
  close: () => void;
}

/** What is open over the screens, the most recent last. */
const layers: Layer[] = [];

/** Whether the sections are on screen, rather than the connect screen that stands in for them. */
let sectionsShown = false;

/** Something laid over the screen that Back should close first; the returned function says it went. */
export function openLayer(close: () => void): () => void {
  const layer: Layer = { close };
  layers.push(layer);
  sync();
  return () => {
    const at = layers.indexOf(layer);
    if (at >= 0) layers.splice(at, 1);
    sync();
  };
}

/** A layer for as long as `open` holds. */
export function useBackLayer(open: boolean, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => (open ? openLayer(() => latest.current()) : undefined), [open]);
}

/** The sections take Back's later steps while they are on screen. */
export function showSections(shown: boolean): void {
  sectionsShown = shown;
  sync();
}

export function useSectionsBack(): void {
  useEffect(() => {
    showSections(true);
    return () => showSections(false);
  }, []);
}

function sectionStep(): (() => void) | null {
  if (!sectionsShown) return null;
  const nav = getNav();
  if (nav.stacks[nav.section].length > 0) return back;
  if (nav.section === "mesh" && nav.meshFocus !== null) return () => focusOnMap(null);
  if (nav.section !== "chats") return () => goSection("chats");
  return null;
}

export function canGoBack(): boolean {
  return layers.length > 0 || sectionStep() !== null;
}

/** One step back; false when there is none left, and the app may leave. */
export function goBack(): boolean {
  const layer = layers.at(-1);
  if (layer) {
    layer.close();
    return true;
  }
  const step = sectionStep();
  step?.();
  return step !== null;
}

// ---- the history guard, for a browser and the desktop shell ----

let guarded = false;
let swallowPop = false;
let settling = false;

/**
 * Settled once the moment's changes are done: a tree drawn again in place (a
 * new language) leaves and comes back within one commit, and its guard stays
 * where it was rather than being taken back and pushed again, which left a
 * stray Back behind.
 */
function sync(): void {
  if (typeof window === "undefined" || !window.history || isCapacitor() || settling) return;
  settling = true;
  queueMicrotask(() => {
    settling = false;
    settle();
  });
}

function settle(): void {
  const wanted = canGoBack();
  if (wanted && !guarded) {
    window.history.pushState({ meshnet: "back" }, "");
    guarded = true;
  } else if (!wanted && guarded) {
    guarded = false;
    swallowPop = true;
    window.history.back();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    if (swallowPop) {
      swallowPop = false;
      return;
    }
    if (!guarded) return;
    guarded = false;
    // The step syncs again, from the store or from the layer's leaving.
    goBack();
  });
  subscribeNav(sync);
}
