// smoke-host-flags.mjs：点状态实时帧（host/session-flags）+ sessions.list.servedAt 定向回归。
// 只构造 Adapter + 伪造 relay/dsh（不连真实中继与 DSH，全部走公开入口）：
//   ① 跑完一轮 → 推一次绿点帧（无 assistant 消息的 turn/end 不产生绿点）
//   ② markSeen 清除 → 再推一次（内容不含它）
//   ③ 审批/提问挂起 → 黄点帧（多会话时内容随之增长）
//   ④ 他端 cancel / questions.respond / approvals.respond → 黄点消失帧
//   ⑤ 快照未变（未知会话 markSeen、同 rpcId 重复暂存、同会话第二个挂起）不重复推帧
//   ⑥ sessions.list 的 servedAt 与全量集合，和增量帧保持一致（只增字段）
import { Adapter } from "../bridge/adapter.js";

let failures = 0;
function ok(name, cond, extra = "") {
  if (cond) console.log(`  PASS ${name}`);
  else { failures += 1; console.log(`  FAIL ${name} ${extra}`); }
}

const relayResponses = [];
const relayEvents = [];
const fakeRelay = {
  url: "http://127.0.0.1:1",
  respond(requestId, type, payload) { relayResponses.push({ requestId, type, payload }); },
  forwardEvent(ev) { relayEvents.push(ev); },
};
const fakeDsh = {
  async unary(method) {
    if (method === "session/list") {
      return {
        ok: true,
        value: {
          items: [{
            sessionId: "sess-1", updatedAt: Date.now(), running: false, blank: false,
            cwd: "D:\\p", projections: { values: { title: "测试会话" } },
          }],
        },
      };
    }
    if (method === "$events/result") return { ok: true, value: undefined };
    return { ok: false, error: { code: "UNSUPPORTED", message: method } };
  },
};

const adapter = new Adapter({ dsh: fakeDsh, relay: fakeRelay, workspaceRoot: ".", e2ee: null });
// workspace 基线（否则 sessions.list 要等 15s 超时）+ $events 就绪（approvals.respond 需要 clientId）
adapter.handleWorkspaceFrame({ type: "baseline", value: { items: [], archivedSessionIds: [] } });
adapter.handleRemoteEvent({ type: "ready", clientId: "cli-1" });

const flags = () => relayEvents.filter((e) => e.frame?.type === "host/session-flags").map((e) => e.frame);
const last = () => flags().at(-1);
const request = (requestId, type, payload) => adapter.handleRequest({ requestId, type, payload });
const turnEvent = (sessionId, type, seq) =>
  adapter.handleSessionFollowFrame(sessionId, { type: "event", event: { type, seq, time: Date.now(), data: {} } });
const completeTurn = (sessionId) => {
  turnEvent(sessionId, "turn/start", 1);
  turnEvent(sessionId, "assistant/message", 2);
  turnEvent(sessionId, "turn/end", 3);
};
const stashApproval = (sessionId, eventId) =>
  adapter.handleRemoteEvent({ type: "waterfall", event: "approval/request", eventId, agentId: sessionId, request: { toolName: "Bash", reason: "需要审批" } });
const stashQuestion = (sessionId, eventId) =>
  adapter.handleRemoteEvent({ type: "waterfall", event: "user-questions/request", eventId, agentId: sessionId, request: { questions: [{ id: "q1", question: "继续?", options: [] }] } });

console.log("[①] 一轮跑完 → 绿点实时帧");
ok("初始没有任何 host/session-flags 帧", flags().length === 0, JSON.stringify(flags()));
completeTurn("sess-1");
ok("跑完一轮推出第 1 帧", flags().length === 1, `frames=${flags().length}`);
ok("帧内容 completedSessionIds=[sess-1] / pendingSessionIds=[]", JSON.stringify(last()?.completedSessionIds) === JSON.stringify(["sess-1"]) && JSON.stringify(last()?.pendingSessionIds) === JSON.stringify([]), JSON.stringify(last()));
completeTurn("sess-5");
ok("另一会话跑完 → 新帧含两个会话", JSON.stringify([...(last()?.completedSessionIds ?? [])].sort()) === JSON.stringify(["sess-1", "sess-5"]), JSON.stringify(last()?.completedSessionIds));
turnEvent("sess-2", "turn/start", 1);
turnEvent("sess-2", "turn/end", 2); // 无 assistant/message → 不算「完成未查看」
ok("无 assistant 消息的 turn/end 不产生绿点也不推帧", flags().length === 2 && !adapter.completedSessions.has("sess-2"), `frames=${flags().length} real=${JSON.stringify([...adapter.completedSessions])}`);

console.log("[②] markSeen 清除绿点 → 再推一帧（内容不含它）");
const before2 = flags().length;
await request("w1", "sessions.markSeen", { sessionId: "sess-1" });
ok("markSeen 应答 ok", relayResponses.find((r) => r.requestId === "w1")?.payload?.ok === true, JSON.stringify(relayResponses.find((r) => r.requestId === "w1")?.payload));
ok("推了清除帧", flags().length === before2 + 1, `frames=${flags().length}`);
ok("新帧不含 sess-1（实际集合同步不含）", last()?.completedSessionIds?.includes("sess-1") === false && !adapter.completedSessions.has("sess-1"), `frame=${JSON.stringify(last()?.completedSessionIds)} real=${JSON.stringify([...adapter.completedSessions])}`);
await request("w1b", "sessions.markSeen", { sessionId: "sess-5" });
ok("全部清除后帧内 completed 为空", Array.isArray(last()?.completedSessionIds) && last().completedSessionIds.length === 0 && adapter.completedSessions.size === 0, JSON.stringify(last()));

console.log("[③] 审批/提问挂起 → 黄点帧");
const before3 = flags().length;
stashApproval("sess-1", "evt-a");
ok("审批挂起推出黄点帧", flags().length === before3 + 1, `frames=${flags().length}`);
ok("帧 pendingSessionIds=[sess-1] 且与实际 pendingRequests 一致", JSON.stringify(last()?.pendingSessionIds) === JSON.stringify([...adapter.pendingRequests.keys()]) && last()?.pendingSessionIds?.includes("sess-1"), `frame=${JSON.stringify(last()?.pendingSessionIds)} real=${JSON.stringify([...adapter.pendingRequests.keys()])}`);
ok("原 approval/requested 帧逻辑未变（仍带 sessionId/rpcId）", relayEvents.some((e) => e.frame?.type === "approval/requested" && e.rpcId === "evt-a" && e.frame.sessionId === "sess-1"));
stashQuestion("sess-2", "evt-b");
ok("第二个会话挂起提问 → 黄点帧含两个会话", JSON.stringify([...(last()?.pendingSessionIds ?? [])].sort()) === JSON.stringify(["sess-1", "sess-2"]), JSON.stringify(last()?.pendingSessionIds));

console.log("[④] 审批/提问 resolved → 黄点消失帧");
adapter.handleRemoteEvent({ type: "cancel", eventId: "evt-a" }); // 他端已应答
ok("cancel 帧后只剩 sess-2", JSON.stringify(last()?.pendingSessionIds) === JSON.stringify(["sess-2"]) && !adapter.pendingRequests.has("sess-1"), `frame=${JSON.stringify(last()?.pendingSessionIds)} real=${JSON.stringify([...adapter.pendingRequests.keys()])}`);
await request("w2", "questions.respond", { rpcId: "evt-b", sessionId: "sess-2", cancel: true });
ok("questions.respond 后黄点清空", adapter.pendingRequests.size === 0 && JSON.stringify(last()?.pendingSessionIds) === JSON.stringify([]), `frame=${JSON.stringify(last()?.pendingSessionIds)} real=${JSON.stringify([...adapter.pendingRequests.keys()])}`);
stashApproval("sess-3", "evt-c");
ok("sess-3 审批挂起 → 黄点含 sess-3", last()?.pendingSessionIds?.includes("sess-3") === true, JSON.stringify(last()?.pendingSessionIds));
await request("w3", "approvals.respond", { rpcId: "evt-c", sessionId: "sess-3", outcome: "rejected" });
ok("approvals.respond ok", relayResponses.find((r) => r.requestId === "w3")?.payload?.ok === true, JSON.stringify(relayResponses.find((r) => r.requestId === "w3")?.payload));
ok("approvals.respond 后黄点消失帧", adapter.pendingRequests.size === 0 && JSON.stringify(last()?.pendingSessionIds) === JSON.stringify([]), `frame=${JSON.stringify(last()?.pendingSessionIds)} real=${JSON.stringify([...adapter.pendingRequests.keys()])}`);

console.log("[⑤] 快照未变 → 不重复推帧");
const before5 = flags().length;
await request("w4", "sessions.markSeen", { sessionId: "sess-unknown" }); // 删一个本来就不存在的会话
ok("未知会话 markSeen 不推帧", flags().length === before5, `frames=${flags().length}`);
stashApproval("sess-4", "evt-d");
const afterFirstD = flags().length;
stashApproval("sess-4", "evt-d"); // 同 rpcId 重复到达（#stashPending 走替换分支）
ok("同 rpcId 重复暂存不推帧", flags().length === afterFirstD, `frames=${flags().length}`);
stashQuestion("sess-4", "evt-e"); // 同会话第二个挂起请求：黄点按会话去重
ok("同会话第二个挂起请求不推帧（pendingSessionIds 未变）", flags().length === afterFirstD, `frames=${flags().length}`);
ok("但集合内确实有 2 条挂起请求", adapter.pendingRequests.get("sess-4")?.length === 2, JSON.stringify(adapter.pendingRequests.get("sess-4")));

console.log("[⑥] sessions.list：servedAt + 全量快照与增量帧一致");
const t0 = Date.now();
await request("r-list", "sessions.list", {});
const listPayload = relayResponses.find((r) => r.requestId === "r-list")?.payload;
const data = listPayload?.data ?? {};
ok("sessions.list ok", listPayload?.ok === true, JSON.stringify(listPayload));
ok("servedAt 是数字且 ≥ 请求发起时间", typeof data.servedAt === "number" && Number.isFinite(data.servedAt) && data.servedAt >= t0 && data.servedAt <= Date.now(), `servedAt=${data.servedAt} t0=${t0}`);
ok("只增字段：sessions/archived/completed/pending 仍在", Array.isArray(data.sessions) && Array.isArray(data.archivedSessionIds) && Array.isArray(data.completedSessionIds) && Array.isArray(data.pendingSessionIds), JSON.stringify(Object.keys(data)));
ok("列表全量集合 == 最后一帧快照", JSON.stringify([...(data.completedSessionIds ?? [])].sort()) === JSON.stringify([...(last()?.completedSessionIds ?? [])].sort()) && JSON.stringify([...(data.pendingSessionIds ?? [])].sort()) === JSON.stringify([...(last()?.pendingSessionIds ?? [])].sort()), `list=${JSON.stringify(data.completedSessionIds)}/${JSON.stringify(data.pendingSessionIds)} frame=${JSON.stringify(last())}`);
ok("列表 generated 与真实集合一致（completed=[] / pending=[sess-4]）", JSON.stringify(data.completedSessionIds) === JSON.stringify([]) && JSON.stringify(data.pendingSessionIds) === JSON.stringify(["sess-4"]), JSON.stringify(data.pendingSessionIds));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
