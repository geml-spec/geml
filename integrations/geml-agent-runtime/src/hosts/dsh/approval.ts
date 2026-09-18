// Gate 4 on DSH.
//
// A transition marked `approval` must not commit without a human saying yes.
// DSH offers `ctx.approval`, but two of its properties are measured facts about
// 0.1.5-rc.1 rather than assumptions, and both would break a naive call:
//
//   * the service is OPTIONAL - a harness may mount no answerer at all, and the
//     agent-loop testkit mounts none;
//   * `request()` THROWS outside an open turn ("the approval/asked +
//     approval/decided audit pair must be turn-enclosed").
//
// Both are denials here, as is any outcome other than `allowed-once`
// (`rejected`, `cancelled`, `unavailable`). An approval gate that fails open is
// not a gate. Tests substitute their own `ApprovalGate` rather than standing up
// an answerer.
//
// The request and gate types live in core/supervisor.ts: they are the seam, and
// the Pi adapter answers the same question with `ctx.ui.confirm`.
import type { ApprovalGate } from "../../core/supervisor.js";

export type { ApprovalGate, ApprovalRequest } from "../../core/supervisor.js";

/** The shape of `ctx` this module needs - deliberately smaller than Context. */
interface MaybeApproval {
  approval?: { request(req: unknown): Promise<string> };
}

/** The default gate: DSH's approval service, failing closed on every other path. */
export function gateFor(ctx: MaybeApproval): ApprovalGate {
  return async (req) => {
    const service = ctx.approval;
    if (!service) return "denied";
    try {
      return (await service.request(req)) === "allowed-once" ? "allowed-once" : "denied";
    } catch {
      return "denied";
    }
  };
}
