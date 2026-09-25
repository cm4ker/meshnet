/**
 * What Android's radio core (`crates/meshcore-core`, behind `MeshRelay.java`)
 * needs to announce messages while the page sleeps: the reader's notice
 * settings (noticePrefs.ts) and the names of this radio, its contacts and its
 * channels, so that its notices read as the page's own do. Sent whenever any
 * of them changes; the native side keeps the last for a start without the page.
 */

import type { SessionState } from "@meshnet/meshcore";
import { signalFile } from "./chime.js";
import { getNoticePrefs, subscribeNoticePrefs } from "./noticePrefs.js";
import { configureCore, nativeLink } from "./relay.js";

/** The JSON the core reads (`WatchConfig` in `watch.rs`). */
export function coreConfig(state: SessionState): string {
  const prefs = getNoticePrefs();
  return JSON.stringify({
    me: state.self?.name ?? "",
    direct: prefs.direct,
    chats: prefs.chats,
    nodes: prefs.nodes,
    chat: prefs.chat,
    contacts: Object.values(state.contacts).map((c) => ({ key: c.key, name: c.name, type: c.type })),
    channels: state.channels.map((c) => ({ index: c.index, name: c.name })),
  });
}

/** Keeps the core told, on Android; stops when the returned function is called. */
export function startCoreWatch(state: () => SessionState, subscribe: (listener: () => void) => () => void): () => void {
  if (!nativeLink()) return () => undefined;
  // The session changes often; the names only now and then.
  let names: [unknown, unknown, unknown] = [null, null, null];
  let told = "";
  const tell = (anyway: boolean): void => {
    const now = state();
    if (!anyway && names[0] === now.self && names[1] === now.contacts && names[2] === now.channels) return;
    names = [now.self, now.contacts, now.channels];
    const json = coreConfig(now);
    const sound = signalFile(getNoticePrefs().signal);
    if (json + sound === told) return;
    told = json + sound;
    configureCore(json, sound).catch((error) => console.warn("Could not configure the radio core's notices", error));
  };
  tell(true);
  const stopSession = subscribe(() => tell(false));
  const stopPrefs = subscribeNoticePrefs(() => tell(true));
  return () => {
    stopSession();
    stopPrefs();
  };
}
