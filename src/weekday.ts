import { t as tr, getLocale } from "./i18n";

// Weekday label keys (0 = Sunday … 6 = Saturday). Shared by the desktop
// week/month grids and the mobile date picker so calendar headers stay
// locale-consistent across every surface.
export const WEEKDAY_KEYS = [
  "weekday.0",
  "weekday.1",
  "weekday.2",
  "weekday.3",
  "weekday.4",
  "weekday.5",
  "weekday.6",
] as const;

export function weekdayLabel(dow: number): string {
  const label = tr(WEEKDAY_KEYS[dow]);
  return getLocale() === "zh" ? `周${label}` : label;
}
