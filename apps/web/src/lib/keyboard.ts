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
 *
 * The plugin hears every keyboard in the app, the one a system prompt brings up
 * too (the Bluetooth PIN on a reconnect), and drops its "will hide" when a
 * "will show" follows at once. So the page makes room only while one of its own
 * fields has the focus, and gives it back on anything that says the keyboard is
 * gone: its "did hide", the field losing the focus, the app going away.
 */
export function followKeyboard(): void {
  const root = document.documentElement;
  root.classList.add("keyboard-follows");
  const set = (height: number) => root.style.setProperty("--keyboard", `${Math.max(0, Math.round(height))}px`);
  const shown = (event: Event) => set(typing() ? ((event as Event & { keyboardHeight?: number }).keyboardHeight ?? 0) : 0);
  // The plugin's window events carry the height on the event itself.
  window.addEventListener("keyboardWillShow", shown);
  window.addEventListener("keyboardDidShow", shown);
  window.addEventListener("keyboardWillHide", () => set(0));
  window.addEventListener("keyboardDidHide", () => set(0));
  // A field that loses the focus to nothing else takes the keyboard with it.
  document.addEventListener("focusout", () => {
    setTimeout(() => {
      if (!typing()) set(0);
    }, 50);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") set(0);
  });
  // A field lower than the room the keyboard leaves comes into view once the keyboard is up.
  window.addEventListener("keyboardDidShow", () => {
    const field = document.activeElement;
    if (typing() && field instanceof HTMLElement) field.scrollIntoView({ block: "nearest" });
  });
}

/**
 * On Android the web view shrinks for the keyboard itself, and the page only
 * needs to know whether the keyboard is up. The focus does not say: a field
 * keeps it after Back or the keyboard's own ˅ has put the keyboard away, and a
 * composer that took that for a keyboard gave up its room above the buttons at
 * the foot of the screen and sat under them.
 */
export function watchKeyboard(): void {
  const root = document.documentElement;
  root.classList.add("keyboard-heard");
  const up = (on: boolean) => root.classList.toggle("keyboard-up", on);
  window.addEventListener("keyboardWillShow", () => up(true));
  window.addEventListener("keyboardDidShow", () => up(true));
  window.addEventListener("keyboardWillHide", () => up(false));
  window.addEventListener("keyboardDidHide", () => up(false));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") up(false);
  });
}

/** Whether one of the page's own fields has the focus, so that the keyboard up is the page's. */
function typing(): boolean {
  const field = document.activeElement;
  return field instanceof HTMLElement && (field.isContentEditable || field.matches("input, textarea, select"));
}
