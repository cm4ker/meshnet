/**
 * Node passwords, kept so a repeater can be signed in to again with one tap.
 *
 * Where they go depends on the shell: the desktop's credential store
 * (Windows Credential Manager, the macOS keychain) through the shell's own
 * commands; the phone's Keychain or Keystore through the secure-storage
 * plugin; in a browser, this site's local storage, which is only as private
 * as the browser profile. Which nodes have one saved is kept apart, in plain
 * settings, so the node list can be drawn without asking the keychain.
 */

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { shell } from "./platform.js";
import { readSetting, writeSetting } from "./storage.js";
import { t } from "../i18n/index.js";

interface Backend {
  get(id: string): Promise<string | null>;
  set(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
}

const LOCAL_PREFIX = "meshnet.secret.";

const localBackend: Backend = {
  async get(id) {
    try {
      return localStorage.getItem(LOCAL_PREFIX + id);
    } catch {
      return null;
    }
  },
  async set(id, value) {
    localStorage.setItem(LOCAL_PREFIX + id, value);
  },
  async delete(id) {
    try {
      localStorage.removeItem(LOCAL_PREFIX + id);
    } catch {
      // Private window: nothing was kept.
    }
  },
};

/** The shell's own commands, `secrets.rs`. */
const tauriBackend: Backend = {
  get: (id) => invoke<string | null>("secret_get", { id }),
  set: (id, value) => invoke("secret_set", { id, value }),
  delete: (id) => invoke("secret_delete", { id }),
};

const capacitorBackend: Backend = {
  async get(id) {
    const { SecureStoragePlugin } = await import("capacitor-secure-storage-plugin");
    try {
      return (await SecureStoragePlugin.get({ key: id })).value;
    } catch {
      // The plugin throws for a key it does not hold.
      return null;
    }
  },
  async set(id, value) {
    const { SecureStoragePlugin } = await import("capacitor-secure-storage-plugin");
    await SecureStoragePlugin.set({ key: id, value });
  },
  async delete(id) {
    const { SecureStoragePlugin } = await import("capacitor-secure-storage-plugin");
    try {
      await SecureStoragePlugin.remove({ key: id });
    } catch {
      // Already gone.
    }
  },
};

function backend(): Backend {
  switch (shell()) {
    case "tauri":
      return tauriBackend;
    case "capacitor":
      return capacitorBackend;
    default:
      return localBackend;
  }
}

/** Where a saved password lives, a whole sentence for the sign-in dialog: "Kept in Windows Credential Manager." */
export function passwordStoreHint(): string {
  switch (shell()) {
    case "tauri":
      return navigator.userAgent.includes("Windows") ? t("connect.passwordKept.windows") : t("connect.passwordKept.keychain");
    case "capacitor":
      return t("connect.passwordKept.phone");
    default:
      return t("connect.passwordKept.browser");
  }
}

// ---- which nodes have one ----

const INDEX_KEY = "meshnet.passwords";
let saved: string[] = readSetting<string[]>(INDEX_KEY, []);
const listeners = new Set<() => void>();

function publish(next: string[]): void {
  saved = next;
  writeSetting(INDEX_KEY, next);
  for (const listener of listeners) listener();
}

function id(nodeKey: string): string {
  return `node-${nodeKey}`;
}

export function hasSavedPassword(nodeKey: string): boolean {
  return saved.includes(nodeKey);
}

/** Node keys with a password saved, for the node list. */
export function useSavedPasswords(): string[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => saved,
  );
}

export async function savePassword(nodeKey: string, password: string): Promise<void> {
  await backend().set(id(nodeKey), password);
  if (!saved.includes(nodeKey)) publish([...saved, nodeKey]);
}

/** Null when none is saved, or the store would not give it up. */
export async function readPassword(nodeKey: string): Promise<string | null> {
  if (!saved.includes(nodeKey)) return null;
  try {
    return await backend().get(id(nodeKey));
  } catch (error) {
    console.warn("saved password could not be read", error);
    return null;
  }
}

export async function forgetPassword(nodeKey: string): Promise<void> {
  try {
    await backend().delete(id(nodeKey));
  } finally {
    publish(saved.filter((k) => k !== nodeKey));
  }
}
