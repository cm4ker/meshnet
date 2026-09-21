import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function icon(paths: string, viewBox = "0 0 24 24") {
  return function Icon({ size = 16, ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...rest}
        dangerouslySetInnerHTML={{ __html: paths }}
      />
    );
  };
}

export const ChatIcon = icon('<path d="M4 5h16v11H8l-4 4z"/>');
export const ContactsIcon = icon('<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M17.5 14.5c2 .8 3.5 2.8 3.5 5.5"/>');
export const RadioIcon = icon('<circle cx="12" cy="13" r="2.5"/><path d="M7.5 17.5a6.5 6.5 0 0 1 0-9M16.5 8.5a6.5 6.5 0 0 1 0 9"/><path d="M4.5 20.5a10.5 10.5 0 0 1 0-15M19.5 5.5a10.5 10.5 0 0 1 0 15"/>');
export const LogIcon = icon('<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>');
export const SettingsIcon = icon('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>');
export const BackIcon = icon('<path d="M15 5l-7 7 7 7"/>');
export const SendIcon = icon('<path d="M4 12l16-8-6 16-2-6z"/>');
export const BluetoothIcon = icon('<path d="M7 7l10 10-5 4V3l5 4L7 17"/>');
export const UsbIcon = icon('<path d="M12 3v18"/><path d="M12 21l-3-3M12 21l3-3"/><path d="M12 9l4-2v4M12 13l-4-2V7"/><circle cx="12" cy="3" r="1"/>');
export const WifiIcon = icon('<path d="M2.5 9a14 14 0 0 1 19 0"/><path d="M5.5 12.5a9.5 9.5 0 0 1 13 0"/><path d="M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r="0.75"/>');

/** The icon for how the radio is reached. */
export function LinkIcon({ kind, size = 16 }: { kind: "ble" | "serial" | "tcp"; size?: number }) {
  if (kind === "ble") return <BluetoothIcon size={size} />;
  if (kind === "tcp") return <WifiIcon size={size} />;
  return <UsbIcon size={size} />;
}
export const StarIcon = icon('<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.9l-5.3 2.8 1.1-5.9-4.3-4.1 5.9-.8z"/>');
export const StarFilledIcon = icon('<path fill="currentColor" d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.9l-5.3 2.8 1.1-5.9-4.3-4.1 5.9-.8z"/>');
export const RefreshIcon = icon('<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>');
export const CloseIcon = icon('<path d="M6 6l12 12M18 6L6 18"/>');
export const CheckIcon = icon('<path d="M5 12.5l4.5 4.5L19 7"/>');
export const DoubleCheckIcon = icon('<path d="M3 12.5l4.5 4.5L14 10.5"/><path d="M10 12.5l4.5 4.5L21 10.5"/>');
export const AlertIcon = icon('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>');
export const ClockIcon = icon('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>');
export const InfoIcon = icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.5"/>');
export const PlusIcon = icon('<path d="M12 5v14M5 12h14"/>');
export const TrashIcon = icon('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>');
export const CopyIcon = icon('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>');
export const RepeaterIcon = icon('<path d="M12 21V9"/><path d="M8 9h8l-1-5H9z"/><path d="M6 14a8 8 0 0 1 0-6M18 14a8 8 0 0 0 0-6"/>');
export const RoomIcon = icon('<path d="M4 20V8l8-5 8 5v12z"/><path d="M10 20v-6h4v6"/>');
export const SensorIcon = icon('<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>');
export const PersonIcon = icon('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>');
export const SignalIcon = icon('<path d="M4 18v-3M9 18v-7M14 18V7M19 18V4"/>');
export const LinkOffIcon = icon('<path d="M10 14l4-4"/><path d="M8.5 15.5l-2 2a3 3 0 0 1-4-4l2-2"/><path d="M15.5 8.5l2-2a3 3 0 0 1 4 4l-2 2"/><path d="M4 4l16 16"/>');
export const MoreIcon = icon('<circle cx="6" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18" cy="12" r="1.2" fill="currentColor"/>');
export const LocationIcon = icon('<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>');
export const PowerIcon = icon('<path d="M12 3v8"/><path d="M6.5 6.5a8 8 0 1 0 11 0"/>');
export const NodesIcon = icon('<circle cx="12" cy="5.5" r="2.5"/><circle cx="5.5" cy="17.5" r="2.5"/><circle cx="18.5" cy="17.5" r="2.5"/><path d="M10.8 7.7 6.8 15.3M13.2 7.7l4 7.6M8 17.5h8"/>');
export const LockIcon = icon('<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>');
export const DownIcon = icon('<path d="M12 5v14M6 13l6 6 6-6"/>');
export const ChevronDownIcon = icon('<path d="M7 10l5 5 5-5"/>');
/** A flood: messages that go everywhere rather than along a route. */
export const WavesIcon = icon(
  '<path d="M3 8.5c1.5-1.4 3-1.4 4.5 0s3 1.4 4.5 0 3-1.4 4.5 0 3 1.4 4.5 0"/><path d="M3 13c1.5-1.4 3-1.4 4.5 0s3 1.4 4.5 0 3-1.4 4.5 0 3 1.4 4.5 0"/><path d="M3 17.5c1.5-1.4 3-1.4 4.5 0s3 1.4 4.5 0 3-1.4 4.5 0 3 1.4 4.5 0"/>',
);
