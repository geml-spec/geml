import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, SETTING_KEYS, settingsFrom, withSetting } from "../dist/hosts/claude-code/settings.js";

test("stored settings are read field by field; anything missing or mistyped is its default", () => {
  assert.deepEqual(settingsFrom(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(settingsFrom("junk"), DEFAULT_SETTINGS);
  assert.deepEqual(settingsFrom({ language: "ja", notify: { inbox: false, stage: "yes" }, band: 7 }), { language: "ja", notify: { inbox: false, refusal: true, stage: false, update: true }, judge: { enabled: true }, trace: { enabled: false } }, "a stored band group is no setting any more");
  assert.equal(settingsFrom({ language: "fr" }).language, "system");
});

test("one key at a time; an unknown key or a wrong type changes nothing", () => {
  const s = DEFAULT_SETTINGS;
  assert.deepEqual(withSetting(s, "notify.stage", true).notify, { inbox: true, refusal: true, stage: true, update: true });
  assert.deepEqual(withSetting(s, "notify.update", false).notify, { inbox: true, refusal: true, stage: false, update: false });
  assert.equal(withSetting(s, "band.vars", false), s, "the band's toggles are gone");
  assert.deepEqual(withSetting(s, "judge.enabled", false).judge, { enabled: false });
  assert.equal(withSetting(s, "language", "en").language, "en");
  assert.equal(withSetting(s, "language", "xx"), s);
  assert.equal(withSetting(s, "notify.stage", "true"), s);
  assert.equal(withSetting(s, "band.nope", true), s);
  assert.equal(withSetting(s, "selectedOnly", true), s, "the board's own toggle is not a setting");
  assert.deepEqual([...SETTING_KEYS], ["language", "notify.inbox", "notify.refusal", "notify.stage", "notify.update", "judge.enabled", "trace.enabled"]);
});

test("the diagnosis trace is a setting, off by default, switched like the others", () => {
  assert.equal(DEFAULT_SETTINGS.trace.enabled, false);
  assert.equal(settingsFrom({ trace: { enabled: true } }).trace.enabled, true);
  assert.equal(withSetting(DEFAULT_SETTINGS, "trace.enabled", true).trace.enabled, true);
  assert.ok(SETTING_KEYS.includes("trace.enabled"));
});
