/**
 * The desktop's icon by the clock (`tray.rs`) carries a dot while anything is
 * unread, coloured by whether a person is waiting or only channels and rooms.
 * The page counts; the shell draws.
 */

import { invoke } from "@tauri-apps/api/core";
import type { SessionState } from "@meshnet/meshcore";
import { isDirect } from "./noticePrefs.js";
import { shell } from "./platform.js";

export interface UnreadSplit {
  /** Messages from people. */
  direct: number;
  /** Messages in channels and rooms. */
  chats: number;
}

export function unreadSplit(state: SessionState): UnreadSplit {
  const split = { direct: 0, chats: 0 };
  for (const [conversation, count] of Object.entries(state.unread)) {
    if (count <= 0) continue;
    if (isDirect(state, conversation)) split.direct += count;
    else split.chats += count;
  }
  return split;
}

/** Keeps the tray icon in step with the unread counts, in the desktop shell only. */
export function startTray(state: () => SessionState, subscribe: (listener: () => void) => () => void): () => void {
  if (shell() !== "tauri") return () => undefined;
  let told = "";
  const update = () => {
    const split = unreadSplit(state());
    const key = `${split.direct}/${split.chats}`;
    if (key === told) return;
    told = key;
    void invoke("tray_unread", { ...split }).catch(() => undefined);
  };
  update();
  return subscribe(update);
}
