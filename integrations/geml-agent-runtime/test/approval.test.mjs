// The approval gate fails closed on every path that is not an explicit grant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateFor } from "../dist/hosts/dsh/approval.js";

const req = { agent: {}, toolName: "agent_transition", reason: "transition #to-pay needs approval" };

test("no approval service at all is a denial, not a crash", async () => {
  assert.equal(await gateFor({})(req), "denied");
});

test("allowed-once is the only grant", async () => {
  assert.equal(await gateFor({ approval: { request: async () => "allowed-once" } })(req), "allowed-once");
  for (const outcome of ["rejected", "cancelled", "unavailable", "", "ALLOWED-ONCE", "allowed"]) {
    assert.equal(await gateFor({ approval: { request: async () => outcome } })(req), "denied", outcome);
  }
});

test("a throwing service is a denial — DSH throws outside an open turn", async () => {
  const gate = gateFor({ approval: { request: async () => { throw new Error("approval.request() outside an open turn"); } } });
  assert.equal(await gate(req), "denied");
});

test("the request reaches the service unchanged", async () => {
  let seen;
  await gateFor({ approval: { request: async (r) => { seen = r; return "allowed-once"; } } })(req);
  assert.deepEqual(seen, req);
});
