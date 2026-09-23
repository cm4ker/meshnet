import { useState } from "react";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";

/** Bundled with the client so it can be read before connecting, even offline. */
export function PrivacyButton() {
  const [open, setOpen] = useState(false);
  return <>
    <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>Privacy policy</Button>
    <Dialog open={open} title="Privacy policy" onClose={() => setOpen(false)} footer={<Button onClick={() => setOpen(false)}>Close</Button>}>
      {open ? <iframe title="Ommesh privacy policy" src="./privacy.html" style={{ width: "100%", height: "60dvh", border: 0 }} /> : null}
    </Dialog>
  </>;
}
