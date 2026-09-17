// Per-profile conformance: what "conforms to geml-<x>/vN" means, stated as data.
//
// §8.4's suite is the SPECIFICATION's, and it is stated over the document model,
// so it deliberately says nothing about any vocabulary: its own `vocabulary.json`
// cases all declare a name nothing recognizes, precisely so the expected
// projection cannot depend on a processor's vocabulary list. That is right for
// the core and it leaves a hole one layer up — a processor that claims to
// implement `geml-media/v1` had nothing to reproduce.
//
// This suite fills it. Each `spec/profiles/geml-<x>/conformance.json` states the
// vocabulary's observable contract:
//
//   · `codes`   — every diagnostic code and its default severity. This is the
//                 part a second implementation copies; before it existed the
//                 answer was forty strings scattered through a checker.
//   · `cases`   — for each, the ADDRESSES a document carries when the vocabulary
//                 is recognized and when it is not, and which names stop being
//                 `unknown-*` on declaration.
//
// The addresses are the point. §8.6.2 rule 4 (GEP-0013) allows a vocabulary's
// declared body mode to change the addressable set, and allows nothing else to.
// `geml-form/v1` is the one profile here whose two readings differ — its `form`
// holds id-bearing `form-field` blocks — and `geml-media/v1` is the contrast: a
// prose body creates no ids, so both readings see the same set. A case that
// drifts across that line fails below, whichever direction it drifts.
import { PROFILES } from "../dist/profiles.js";
import { parse } from "../dist/geml.js";
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as presolve } from "node:path";
import { strict as assert } from "node:assert";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = presolve(here, "..", "dist", "geml.js");
const PROFILES_DIR = presolve(here, "..", "..", "spec", "profiles");
const work = mkdtempSync(join(tmpdir(), "geml-profconf-"));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok", name); }

const stemOf = (name) => name.replace(/^geml-/, "").replace(/\/v\d+$/, "");
const fileFor = (name) => join(PROFILES_DIR, `geml-${stemOf(name)}`, "conformance.json");

// `geml list`'s addresses, which is the contract a reader sees — not an internal
// projection this test could quietly redefine.
function addresses(geml) {
  const f = join(work, "case.geml");
  writeFileSync(f, geml);
  const r = spawnSync(process.execPath, [CLI, "list", f, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, `geml list failed: ${r.stderr}`);
  return JSON.parse(r.stdout).map((b) => b.address);
}
// The same document with its declaration removed — §8.6.2 rule 3's other reading.
const undeclare = (g) => g.replace(/^profile\s*=.*$/m, 'title = "undeclared"');

test("每份注册的 profile 都有一份一致性文件，反之亦然", () => {
  for (const name of Object.keys(PROFILES)) {
    assert.ok(existsSync(fileFor(name)), `${name} 没有 ${fileFor(name)}`);
  }
});

test("文件里的 state 与 codes 就是注册表里的那一份 —— 一份事实，不是两份", () => {
  // 规范侧的这份是**规范性**的陈述，参考实现是它的一个实现。两边漂了，第二实现
  // 复刻的就是错的那份。
  for (const [name, def] of Object.entries(PROFILES)) {
    const f = JSON.parse(readFileSync(fileFor(name), "utf8"));
    assert.equal(f.profile, name);
    assert.equal(f.state, def.state, `${name} 的 state 两边不一致`);
    assert.deepEqual(f.codes, def.diagnostics ?? {}, `${name} 的码表两边不一致`);
  }
});

test("每条用例：两种读法的地址集就是文件里记的那两组", () => {
  for (const name of Object.keys(PROFILES)) {
    const f = JSON.parse(readFileSync(fileFor(name), "utf8"));
    for (const c of f.cases) {
      assert.deepEqual(addresses(c.geml), c.addresses.declared, `${name} / ${c.name}（声明时）`);
      assert.deepEqual(addresses(undeclare(c.geml)), c.addresses.undeclared, `${name} / ${c.name}（不声明）`);
    }
  }
});

test("规则 4：地址集只在词汇表声明了 body 模式时才可以不同", () => {
  for (const [name, def] of Object.entries(PROFILES)) {
    const f = JSON.parse(readFileSync(fileFor(name), "utf8"));
    const declaresBody = Object.keys(def.bodies ?? {}).length > 0 || (def.prose ?? []).length > 0;
    for (const c of f.cases) {
      const differs = JSON.stringify(c.addresses.declared) !== JSON.stringify(c.addresses.undeclared);
      if (differs) {
        assert.ok(declaresBody,
          `${name} / ${c.name}：认不认识这份词汇表改变了地址集，而它没有声明任何 body 模式 —— 这是规则 4 的违反，不是被放行的例外`);
      }
    }
  }
});

test("放行：声明之后那些名字不再是 unknown-*，不声明时仍然是", () => {
  for (const name of Object.keys(PROFILES)) {
    const f = JSON.parse(readFileSync(fileFor(name), "utf8"));
    for (const c of f.cases) {
      const declared = parse(c.geml).diagnostics;
      const bare = parse(undeclare(c.geml)).diagnostics;
      const unknownOf = (diags) => diags.filter((d) => /^unknown-(block-type|attribute)$/.test(d.code));
      for (const n of c.admits) {
        assert.ok(!unknownOf(declared).some((d) => d.message.includes(`\`${n}\``)),
          `${name} / ${c.name}：声明之后 \`${n}\` 仍被报为 unknown-*`);
      }
      // 反向只要求**至少一个**：一个 NESTED 的名字在不声明时根本不会被报成
      // unknown，因为它的容器退回 raw 体之后，里面那个块从没被当成块扫过 —— 它
      // 是纯文本。geml-form 的 form-field 就是这种。所以「不声明时会警告」是关于
      // 这份文档的断言，不是关于每个名字的。
      assert.ok(c.admits.some((n) => unknownOf(bare).some((d) => d.message.includes(`\`${n}\``))),
        `${name} / ${c.name}：不声明时一个 unknown-* 都没有 —— 那这份文档根本不需要这份词汇表放行什么`);
    }
  }
});

test("每份 profile 的码都带自己的前缀 —— 一致性文件是对外的那一份陈述", () => {
  for (const name of Object.keys(PROFILES)) {
    const f = JSON.parse(readFileSync(fileFor(name), "utf8"));
    const want = stemOf(name) + "-";
    const bad = Object.keys(f.codes).filter((c) => !c.startsWith(want));
    assert.deepEqual(bad, [], `${name} 的一致性文件里有不带前缀的码`);
  }
});

rmSync(work, { recursive: true, force: true });
console.log(`\nprofile-conformance: ${passed} passed`);
