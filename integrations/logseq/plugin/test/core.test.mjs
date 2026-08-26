// Tests for the plugin-side signaller — dependency-free on purpose: the
// `logseq` global is a plain double, timers are a manual scheduler, so this
// runs from the parent package's test chain with no npm install in plugin/.
import { strict as assert } from "node:assert";
import {
  createSyncSignaler,
  formatStatus,
  SIGNAL_FILE,
} from "../src/core.mjs";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log("ok", name);
}

function makeScheduler() {
  const timers = new Map();
  let nextId = 1;
  return {
    schedule(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    async fire() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, t] of due) await t.fn();
    },
    pending() {
      return [...timers.values()];
    },
  };
}

function makeLogseq({ failSetItem = false } = {}) {
  const calls = { setItem: [], onChangedHandlers: [], unsubscribed: 0 };
  return {
    calls,
    DB: {
      onChanged(cb) {
        calls.onChangedHandlers.push(cb);
        return () => {
          calls.unsubscribed++;
        };
      },
    },
    FileStorage: {
      async setItem(key, value) {
        if (failSetItem) throw new Error("storage is on fire");
        calls.setItem.push({ key, value });
      },
    },
  };
}

async function run() {
  await test("a burst of changes produces exactly one signal", async () => {
    const sched = makeScheduler();
    const lsq = makeLogseq();
    const s = createSyncSignaler({
      logseq: lsq,
      debounceMs: 5000,
      schedule: sched.schedule,
      cancel: sched.cancel,
      now: () => 42,
    });
    s.start();
    const emit = lsq.calls.onChangedHandlers[0];
    emit();
    emit();
    emit();
    assert.equal(sched.pending().length, 1, "burst must collapse to one pending timer");
    await sched.fire();
    assert.equal(lsq.calls.setItem.length, 1);
    const { key, value } = lsq.calls.setItem[0];
    assert.equal(key, SIGNAL_FILE);
    assert.deepEqual(JSON.parse(value), { at: 42, changesSeen: 3 });
    assert.equal(s.state.signalsWritten, 1);
  });

  await test("a change after a flush schedules a second signal", async () => {
    const sched = makeScheduler();
    const lsq = makeLogseq();
    const s = createSyncSignaler({
      logseq: lsq,
      schedule: sched.schedule,
      cancel: sched.cancel,
    });
    s.start();
    const emit = lsq.calls.onChangedHandlers[0];
    emit();
    await sched.fire();
    emit();
    await sched.fire();
    assert.equal(lsq.calls.setItem.length, 2);
  });

  await test("stop() cancels the pending signal and unsubscribes", async () => {
    const sched = makeScheduler();
    const lsq = makeLogseq();
    const s = createSyncSignaler({
      logseq: lsq,
      schedule: sched.schedule,
      cancel: sched.cancel,
    });
    s.start();
    lsq.calls.onChangedHandlers[0]();
    s.stop();
    assert.equal(sched.pending().length, 0, "stop must cancel the timer");
    await sched.fire();
    assert.equal(lsq.calls.setItem.length, 0, "no signal after stop");
    assert.equal(lsq.calls.unsubscribed, 1);
  });

  await test("a failing storage write lands in state.lastError, not as a throw", async () => {
    const sched = makeScheduler();
    const lsq = makeLogseq({ failSetItem: true });
    const s = createSyncSignaler({
      logseq: lsq,
      schedule: sched.schedule,
      cancel: sched.cancel,
    });
    s.start();
    lsq.calls.onChangedHandlers[0]();
    await sched.fire(); // must not reject
    assert.equal(s.state.lastError, "storage is on fire");
    assert.equal(s.state.signalsWritten, 0);
  });

  await test("setDebounce changes the delay of subsequent signals", () => {
    const sched = makeScheduler();
    const lsq = makeLogseq();
    const s = createSyncSignaler({
      logseq: lsq,
      debounceMs: 5000,
      schedule: sched.schedule,
      cancel: sched.cancel,
    });
    s.start();
    s.setDebounce(250);
    lsq.calls.onChangedHandlers[0]();
    assert.equal(sched.pending()[0].ms, 250);
  });

  await test("formatStatus covers absent, invalid, failed and healthy status", () => {
    assert.ok(formatStatus(null).includes("no watcher status yet"));
    assert.ok(formatStatus("{nope").includes("not valid JSON"));
    assert.ok(
      formatStatus(JSON.stringify({ ok: false, at: "T", error: "boom" })).includes("FAILED at T — boom")
    );
    const healthy = formatStatus(
      JSON.stringify({ ok: true, at: "T", written: 2, unchanged: 5, orphaned: 1 })
    );
    assert.ok(healthy.includes("2 written"));
    assert.ok(healthy.includes("5 unchanged"));
    assert.ok(healthy.includes("1 orphaned"));
    assert.ok(!healthy.includes("deleted"));
  });

  console.log(`\n${passed} plugin core tests passed.`);
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
