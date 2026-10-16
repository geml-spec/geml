// Times as the band and the board say them. Pure and Node-free; the clock is
// an argument, never read here.
import type { T } from "./text.js";

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/** Milliseconds between two ISO times; NaN when either does not parse. */
export function between(fromIso: string, toIso: string): number {
  return Date.parse(toIso) - Date.parse(fromIso);
}

/** A span in words: `2 小时`, `1 小时 48 分`, `12 分钟`, `30 秒`; negative or unreadable, `0 秒`. */
export function durationText(ms: number, t: T): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms >= DAY) {
    const days = Math.floor(ms / DAY), hours = Math.floor((ms % DAY) / HOUR);
    return hours > 0 ? t("{0} 天 {1} 小时", days, hours) : t("{0} 天", days);
  }
  if (ms >= HOUR) {
    const hours = Math.floor(ms / HOUR), minutes = Math.floor((ms % HOUR) / MINUTE);
    return minutes > 0 ? t("{0} 小时 {1} 分", hours, minutes) : t("{0} 小时", hours);
  }
  if (ms >= MINUTE) return t("{0} 分钟", Math.floor(ms / MINUTE));
  return t("{0} 秒", Math.floor(ms / 1000));
}

/** How long ago: `刚刚` under a minute, then `3 分钟前`, `2 小时前`, `昨天`, `3 天前`; unreadable, empty. */
export function agoText(atIso: string, nowIso: string, t: T): string {
  const ms = between(atIso, nowIso);
  if (!Number.isFinite(ms)) return "";
  if (ms < MINUTE) return t("刚刚");
  if (ms < HOUR) return t("{0} 分钟前", Math.floor(ms / MINUTE));
  if (ms < DAY) return t("{0} 小时前", Math.floor(ms / HOUR));
  if (ms < 2 * DAY) return t("昨天");
  return t("{0} 天前", Math.floor(ms / DAY));
}

/** How long something has waited: `等了 12 分钟`; unreadable, empty. */
export function waitedText(sinceIso: string, nowIso: string, t: T): string {
  const ms = between(sinceIso, nowIso);
  return Number.isFinite(ms) ? t("等了 {0}", durationText(ms, t)) : "";
}

/** The day of an ISO time as a heading, in the host's local time: `今天`, `昨天`, else its month and day; unreadable, empty. */
export function dayText(atIso: string, nowIso: string, t: T): string {
  const at = new Date(atIso), now = new Date(nowIso);
  if (Number.isNaN(at.getTime()) || Number.isNaN(now.getTime())) return "";
  const day = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const back = Math.round((day(now) - day(at)) / DAY);
  if (back === 0) return t("今天");
  if (back === 1) return t("昨天");
  return t("{0} 月 {1} 日", at.getMonth() + 1, at.getDate());
}

/** `HH:MM` of an ISO time in the host's local time; the raw text when it does not parse. */
export function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
