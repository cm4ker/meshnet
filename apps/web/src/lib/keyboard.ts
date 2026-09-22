/**
 * On iOS the page follows the keyboard itself.
 *
 * Capacitor's Keyboard plugin could shrink the web view instead ("native"), but
 * it waits until the keyboard has finished rising, plus a fifth of a second,
 * and then shrinks it in one step: the keyboard slides over the conversation,
 * and only afterwards does the conversation jump up. Here the plugin leaves the
 * web view alone (`resize: "none"`, capacitor.config.ts) and reports the
 * keyboard's height as the keyboard starts to move. `--keyboard` animates to it
 * over the keyboard's own quarter second (styles.css), and the app, the safe
 * area under it and the fixed layers are laid out from it, so they rise with
 * the keyboard.
 */
export function followKeyboard(): void {
  const root = document.documentElement;
  root.classList.add("keyboard-follows");
  const set = (height: number) => root.style.setProperty("--keyboard", `${Math.max(0, Math.round(height))}px`);
  // The plugin's window events carry the height on the event itself.
  window.addEventListener("keyboardWillShow", (event) => set((event as Event & { keyboardHeight?: number }).keyboardHeight ?? 0));
  window.addEventListener("keyboardWillHide", () => set(0));
  // A field lower than the room the keyboard leaves comes into view once the keyboard is up.
  window.addEventListener("keyboardDidShow", () => {
    const field = document.activeElement;
    if (field instanceof HTMLElement && field !== document.body) field.scrollIntoView({ block: "nearest" });
  });
}
