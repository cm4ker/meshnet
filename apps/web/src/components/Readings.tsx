import type { LppReading } from "@meshnet/meshcore";
import { InfoRow } from "../ui/List.js";

/** Cayenne LPP readings as rows of a group: what it measures, on which channel, and the value in its unit. */
export function Readings({ readings }: { readings: LppReading[] }) {
  if (readings.length === 0) return <InfoRow label="No readings">—</InfoRow>;
  return (
    <>
      {readings.map((r, i) => (
        <InfoRow key={i} label={label(r)} hint={`channel ${r.channel}`}>
          {value(r)}
        </InfoRow>
      ))}
    </>
  );
}
function label(r: LppReading): string {
  return r.type.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function value(r: LppReading): string {
  switch (r.type) {
    case "voltage":
      return `${r.volts.toFixed(2)} V`;
    case "temperature":
      return `${r.celsius.toFixed(1)} °C`;
    case "humidity":
      return `${r.percent.toFixed(1)} %`;
    case "barometer":
      return `${r.hpa.toFixed(1)} hPa`;
    case "current":
      return `${r.amps.toFixed(3)} A`;
    case "power":
      return `${r.watts} W`;
    case "energy":
      return `${r.kwh.toFixed(3)} kWh`;
    case "luminosity":
      return `${r.lux} lx`;
    case "altitude":
      return `${r.meters} m`;
    case "distance":
      return `${r.meters.toFixed(3)} m`;
    case "concentration":
      return `${r.ppm} ppm`;
    case "direction":
      return `${r.degrees}°`;
    case "frequency":
      return `${r.hz} Hz`;
    case "percentage":
      return `${r.percent} %`;
    case "gps":
      return `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)} · ${r.alt.toFixed(0)} m`;
    case "accelerometer":
    case "gyrometer":
      return `${r.x}, ${r.y}, ${r.z}`;
    case "colour":
      return `rgb(${r.r}, ${r.g}, ${r.b})`;
    case "unixTime":
      return new Date(r.seconds * 1000).toLocaleString();
    case "unknown":
      return `type ${r.code}`;
    default:
      return String((r as { value: number }).value);
  }
}
