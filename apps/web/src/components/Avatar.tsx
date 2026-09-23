import { AdvType } from "@meshnet/meshcore";
import { hue, initials, trailingEmoji } from "../lib/format.js";
import { RepeaterIcon, RoomIcon, SensorIcon } from "./Icons.js";

/**
 * A swatch with initials for a person, or the emoji their name ends with; a
 * glyph for infrastructure. The hue is hashed from the name; lightness and
 * chroma come from the stylesheet, so a hashed colour stays inside the
 * palette's range.
 */
export function Avatar({ name, type = AdvType.Chat, size = 32, channel = false, icon }: { name: string; type?: number | undefined; size?: number; channel?: boolean; icon?: React.ReactNode }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.38), "--hue": hue(name) } as React.CSSProperties;
  let glyph: React.ReactNode;
  if (icon) glyph = icon;
  else if (channel) glyph = "#";
  else if (type === AdvType.Repeater) glyph = <RepeaterIcon size={size * 0.55} />;
  else if (type === AdvType.Room) glyph = <RoomIcon size={size * 0.55} />;
  else if (type === AdvType.Sensor) glyph = <SensorIcon size={size * 0.55} />;
  else {
    const emoji = trailingEmoji(name);
    if (emoji) style.fontSize = Math.round(size * 0.55);
    glyph = emoji ?? initials(name);
  }
  return (
    <span className="avatar" style={style} aria-hidden="true">
      {glyph}
    </span>
  );
}
