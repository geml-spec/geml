// geml-form/v1 的检查器：GEP-0008 的家族诊断，加上 profile §5 允许的值警告。
//
// 结构上的三条（form-child-outside-form / form-field-missing-name /
// form-duplicate-name）是解析期的诊断，在 geml.ts 里；这里的六条要看属性的
// **值**和整个 form 的成员，所以在解析之后、按地址报，和 statechart-check 同一形状。
//
// 约束只看「读不读得懂」，从不拿去判一个值（profile §3：declared, never
// evaluated）——`min=0` 旁边的 `value=-5` 不是这里的事。
import { parse, type Block } from "./geml.js";
import { type ProfileDiagnostic, type ProfileIO } from "./profiles.js";

type B = Extract<Block, { kind: "block" }>;
type Value = B["attrs"][string];

/** GEP-0008 的七个 `type=` 值，按值的形状而不是控件的形状选的。 */
const FIELD_TYPES: ReadonlySet<string> = new Set(["text", "textarea", "number", "date", "boolean", "select", "file"]);

/** 一个十进制数。属性里写成数字的已经是 number；引号里的字符串照同一个文法读。 */
const NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const asNumber = (v: Value | undefined): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && NUMBER.test(v) ? Number(v) : undefined;
  return n !== undefined && Number.isFinite(n) ? n : undefined;
};

/** ISO-8601 的日历日期 `YYYY-MM-DD`，且这一天存在（`2024-02-30` 不存在）。 */
const isoDate = (v: Value | undefined): boolean => {
  const m = typeof v === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return days !== undefined && d >= 1 && d <= days;
};

/** ECMAScript 正则，按 `u` 标志读（profile §2）。 */
const isPattern = (v: Value | undefined): boolean => {
  if (typeof v !== "string" && typeof v !== "number") return false;
  try { new RegExp(String(v), "u"); return true; } catch { return false; }
};

/**
 * profile §5 的 MAY：一个约束值按它这个键自己的读法读不懂。`min`/`max` 的读法取决于
 * `type=`（number 读数，date 读日期），别的类型上不判；其余三个键的读法与类型无关。
 */
function unreadable(attrs: B["attrs"]): string[] {
  const out: string[] = [];
  const has = (k: string): boolean => Object.hasOwn(attrs, k);
  const type = attrs["type"];
  for (const k of ["min", "max"]) {
    if (!has(k)) continue;
    if (type === "number" && asNumber(attrs[k]) === undefined) out.push(`\`${k}=\` on a \`number\` field is not a number`);
    if (type === "date" && !isoDate(attrs[k])) out.push(`\`${k}=\` on a \`date\` field is not an ISO-8601 date (YYYY-MM-DD)`);
  }
  if (has("step")) {
    const n = asNumber(attrs["step"]);
    if (n === undefined || n <= 0) out.push("`step=` is not a positive number");
  }
  if (has("maxlength")) {
    const n = asNumber(attrs["maxlength"]);
    if (n === undefined || n < 0 || !Number.isInteger(n)) out.push("`maxlength=` is not a non-negative integer");
  }
  if (has("pattern") && !isPattern(attrs["pattern"])) out.push("`pattern=` is not a valid regular expression");
  return out;
}

/**
 * 一个 form 体里的块，连同它的 group 里的。不只 `form-*`：一个 `options=` 指着
 * 同一个 form 里的 `table`，报的时候要说出它指着的是 `table`。
 */
function membersOf(form: B): B[] {
  const out: B[] = [];
  for (const b of form.children ?? []) {
    if (b.kind !== "block") continue;
    out.push(b);
    if (b.type === "form-group") for (const c of b.children ?? []) if (c.kind === "block") out.push(c);
  }
  return out;
}

export function checkForm(entry: string, io: ProfileIO): ProfileDiagnostic[] {
  const src = io.readDoc(entry);
  if (src === null) return [];
  const out: ProfileDiagnostic[] = [];
  const report = (b: B, severity: ProfileDiagnostic["severity"], code: string, message: string): void => {
    const d: ProfileDiagnostic = { severity, code, message, doc: entry };
    if (b.id !== undefined) d.id = b.id;
    out.push(d);
  };

  // 一个字段的 `#` 属性指向它所在 form 的 `form-*` 块（GEP-0008，*Fields are named*）：
  // `options=` 落在 `form-options` 上，`label=`/`description=`/`placeholder=` 落在
  // `form-note` 上。group 的文字不是引用 —— GEP 只给 form-field 的属性这条规则。
  const checkMembers = (form: B): void => {
    const members = membersOf(form);
    const find = (v: string): B | undefined => (v.startsWith("#") ? members.find((m) => m.id === v.slice(1)) : undefined);
    const used = new Set<B>();
    const named = (t: B | undefined): string => (t === undefined ? "nothing in this form" : `a \`${t.type}\``);
    for (const f of members) {
      if (f.type !== "form-field") continue;
      const o = f.attrs["options"];
      if (o !== undefined) {
        const t = typeof o === "string" ? find(o) : undefined;
        if (t?.type === "form-options") used.add(t);
        else report(f, "error", "form-options-not-form-options", `\`options=${String(o)}\` names ${named(t)}, not a \`form-options\` of this form (GEP-0008)`);
      }
      for (const key of ["label", "description", "placeholder"]) {
        const v = f.attrs[key];
        if (typeof v !== "string" || !v.startsWith("#")) continue;
        const t = find(v);
        if (t?.type === "form-note") used.add(t);
        else report(f, "error", "form-note-not-form-note", `\`${key}=${v}\` names ${named(t)}, not a \`form-note\` of this form (GEP-0008)`);
      }
    }
    for (const m of members) {
      if ((m.type === "form-options" || m.type === "form-note") && !used.has(m)) {
        report(m, "warning", "form-unused-block", `no field of this form points at this \`${m.type}\` (GEP-0008)`);
      }
    }
  };

  const walk = (bs: Block[]): void => {
    for (const b of bs) {
      if (b.kind !== "block") continue;
      if (b.type === "form-field") {
        const type = b.attrs["type"];
        if (type !== undefined && !(typeof type === "string" && FIELD_TYPES.has(type))) {
          report(b, "warning", "form-unknown-field-type", `\`type=${String(type)}\` is none of the seven field types; it renders as \`text\` (GEP-0008)`);
        }
        // `form-field` 的体是 raw（profile 只给 form 和 form-group 声明了 flow）。
        if ((b.raw ?? []).some((l) => l.trim() !== "")) {
          report(b, "warning", "form-field-has-body", "a form field's body is empty; its text lives in attributes, and this body is not rendered (GEP-0008)");
        }
        for (const why of unreadable(b.attrs)) {
          report(b, "warning", "form-constraint-unreadable", `${why}; a constraint is declared, never evaluated, and a handler may not read this one (geml-form §5)`);
        }
      }
      if (b.type === "form") checkMembers(b);
      walk(b.children ?? []);
    }
  };
  walk(parse(src).children);
  return out;
}
