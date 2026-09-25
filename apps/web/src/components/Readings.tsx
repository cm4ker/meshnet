import type { LppReading } from "@meshnet/meshcore";
import { locale, t, type Key } from "../i18n/index.js";
import { InfoRow } from "../ui/List.js";

/** What each kind of reading measures. */
const LABELS: Record<LppReading["type"], Key> = {
  digitalIn: "radio.readings.digitalIn",
  digitalOut: "radio.readings.digitalOut",
  analogIn: "radio.readings.analogIn",
  analogOut: "radio.readings.analogOut",
  genericSensor: "radio.readings.genericSensor",
  luminosity: "radio.readings.luminosity",
  presence: "radio.readings.presence",
  temperature: "radio.readings.temperature",
  humidity: "radio.readings.humidity",
  accelerometer: "radio.readings.accelerometer",
  barometer: "radio.readings.barometer",
  voltage: "radio.readings.voltage",
  current: "radio.readings.current",
  frequency: "radio.readings.frequency",
  percentage: "radio.readings.percentage",
  altitude: "radio.readings.altitude",
  concentration: "radio.readings.concentration",
  power: "radio.readings.power",
  distance: "radio.readings.distance",
  energy: "radio.readings.energy",
  direction: "radio.readings.direction",
  unixTime: "radio.readings.unixTime",
  gyrometer: "radio.readings.gyrometer",
  colour: "radio.readings.colour",
  gps: "radio.readings.gps",
  switch: "radio.readings.switch",
  unknown: "radio.readings.unknown",
};

/** Cayenne LPP readings as rows of a group: what it measures, on which channel, and the value in its unit. */
export function Readings({ readings }: { readings: LppReading[] }) {
  if (readings.length === 0) return <InfoRow label={t("radio.readings.none")}>—</InfoRow>;
  return (
    <>
      {readings.map((r, i) => (
        <InfoRow key={i} label={t(LABELS[r.type])} hint={t("radio.readings.channel", { channel: r.channel })}>
          {value(r)}
        </InfoRow>
      ))}
    </>
  );
}
function value(r: LppReading): string {
  switch (r.type) {
    case "voltage":
      return t("common.volts", { value: r.volts.toFixed(2) });
    case "temperature":
      return `${r.celsius.toFixed(1)} °C`;
    case "humidity":
      return `${r.percent.toFixed(1)} %`;
    case "barometer":
      return t("radio.readings.hpa", { value: r.hpa.toFixed(1) });
    case "current":
      return t("radio.readings.milliamps", { value: Math.round(r.amps * 1000) });
    case "power":
      // Sent in whole watts (LPP_POWER), so a milliwatt figure is only ever a thousand of them.
      return t("radio.readings.milliwatts", { value: r.watts * 1000 });
    case "energy":
      return t("radio.readings.kwh", { value: r.kwh.toFixed(3) });
    case "luminosity":
      return t("radio.readings.lux", { value: r.lux });
    case "altitude":
      return t("common.meters", { value: r.meters });
    case "distance":
      return t("common.meters", { value: r.meters.toFixed(3) });
    case "concentration":
      return `${r.ppm} ppm`;
    case "direction":
      return `${r.degrees}°`;
    case "frequency":
      return t("radio.readings.hz", { value: r.hz });
    case "percentage":
      return `${r.percent} %`;
    case "gps":
      return t("radio.readings.gpsValue", { lat: r.lat.toFixed(4), lon: r.lon.toFixed(4), alt: r.alt.toFixed(0) });
    case "accelerometer":
    case "gyrometer":
      return `${r.x}, ${r.y}, ${r.z}`;
    case "colour":
      return `rgb(${r.r}, ${r.g}, ${r.b})`;
    case "unixTime":
      return new Date(r.seconds * 1000).toLocaleString(locale());
    case "unknown":
      return t("radio.readings.unknownType", { code: r.code });
    default:
      return String((r as { value: number }).value);
  }
}
