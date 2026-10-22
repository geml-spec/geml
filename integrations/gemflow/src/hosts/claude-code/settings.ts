// The shell's settings (spec §8.7), kept in the plugin's own store across
// sessions: when the desktop is told, whether a new version is announced on
// the board, and the words' language. Pure: parsing a stored value, and the defaults.

export type LanguageSetting = "system" | "zh" | "en" | "ja";

export interface Settings {
  language: LanguageSetting;
  /** Desktop notifications: something to decide or accept, a refusal (one per reason every few minutes), a stage change; and a new version, said on the board. */
  notify: { inbox: boolean; refusal: boolean; stage: boolean; update: boolean };
  /** Each turn's judgement: whether a typed prompt picks a waiting option, read by a small model. */
  judge: { enabled: boolean };
  /** The diagnosis trace: presses, drawings, loads into .geml/trace.log and the transcript. Off unless a board problem is being chased: on, it floods the conversation. */
  trace: { enabled: boolean };
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  language: "system",
  notify: Object.freeze({ inbox: true, refusal: true, stage: false, update: true }),
  judge: Object.freeze({ enabled: true }),
  trace: Object.freeze({ enabled: false }),
}) as Settings;

/** The settings keys a `setting` action names, `group.field`. */
export const SETTING_KEYS = ["language", "notify.inbox", "notify.refusal", "notify.stage", "notify.update", "judge.enabled", "trace.enabled"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

const LANGUAGES: ReadonlySet<string> = new Set(["system", "zh", "en", "ja"]);

/** A stored value read as settings: every field as stored when it is of the right type, else its default. */
export function settingsFrom(stored: unknown): Settings {
  const v = (typeof stored === "object" && stored !== null ? stored : {}) as Record<string, unknown>;
  const group = (name: "notify" | "judge" | "trace"): Record<string, unknown> => (typeof v[name] === "object" && v[name] !== null ? (v[name] as Record<string, unknown>) : {});
  const bool = (g: Record<string, unknown>, k: string, d: boolean): boolean => (typeof g[k] === "boolean" ? (g[k] as boolean) : d);
  const n = group("notify");
  return {
    language: typeof v["language"] === "string" && LANGUAGES.has(v["language"]) ? (v["language"] as LanguageSetting) : DEFAULT_SETTINGS.language,
    notify: { inbox: bool(n, "inbox", true), refusal: bool(n, "refusal", true), stage: bool(n, "stage", false), update: bool(n, "update", true) },
    judge: { enabled: bool(group("judge"), "enabled", true) },
    trace: { enabled: bool(group("trace"), "enabled", false) },
  };
}

/** The settings with one key changed; an unknown key or a value of the wrong type changes nothing. */
export function withSetting(s: Settings, key: string, value: string | boolean): Settings {
  if (key === "language") return typeof value === "string" && LANGUAGES.has(value) ? { ...s, language: value as LanguageSetting } : s;
  const [group, field] = key.split(".");
  if (typeof value !== "boolean" || field === undefined) return s;
  if (group === "notify" && field in s.notify) return { ...s, notify: { ...s.notify, [field]: value } };
  if (group === "judge" && field in s.judge) return { ...s, judge: { ...s.judge, [field]: value } };
  if (group === "trace" && field in s.trace) return { ...s, trace: { ...s.trace, [field]: value } };
  return s;
}
