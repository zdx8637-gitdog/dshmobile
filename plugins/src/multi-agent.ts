/**
 * 跨机协作（多 Agent）——P1b：只读工具。
 *
 * ⚠ 设计约束（用户拍板）：
 *  - **默认关闭**：`~/.dsh-mobile/multi-agent.json` 存在且 `{enabled:true}` 才安装；
 *  - 关闭时：不注册工具、不发请求、不建定时器 —— 对现有桥/App 零影响；
 *  - 只新增工具，不改动插件既有的任何代码路径。
 *
 * 依赖的既有设施（都不改动）：
 *  - relay `GET /devices`（用户 JWT）
 *  - relay `POST /devices/:id/rpc`（需服务端 `REMOTE_RPC=on`）
 *  - `~/.dsh-mobile/session.json` 的 access/refresh token（与 App/桥同一份）
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type Deps = { stateDir: string; log: (msg: string) => void };

type SessionFile = { accessToken?: string; refreshToken?: string; username?: string };

const TIMEOUT_MS = 15_000;

function readJson(file: string): any | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function loadSession(stateDir: string): SessionFile | null {
  return readJson(path.join(stateDir, "session.json"));
}

function saveSession(stateDir: string, s: SessionFile): void {
  try {
    writeFileSync(path.join(stateDir, "session.json"), JSON.stringify(s));
  } catch {
    /* 写不进去就只在内存用；下次刷新再说 */
  }
}

function relayFromConfig(stateDir: string): string {
  const cfg = readJson(path.join(stateDir, "config.json"));
  const url = typeof cfg?.relay?.url === "string" ? cfg.relay.url : typeof cfg?.relayUrl === "string" ? cfg.relayUrl : "";
  return String(url).replace(/\/$/, "");
}

/** 带 refresh 的 JSON 请求：401 时用 refreshToken 换一次再重试。 */
async function relayJson(
  stateDir: string,
  base: string,
  pathname: string,
  init: { method?: string; body?: unknown } = {},
  log?: (msg: string) => void,
): Promise<any> {
  const session = loadSession(stateDir);
  let token = session?.accessToken ?? "";
  const doFetch = async (bearer: string) => {
    const res = await fetch(base + pathname, {
      method: init.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res;
  };

  let res = await doFetch(token);
  if (res.status === 401 && session?.refreshToken) {
    try {
      const rf = await fetch(base + "/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const rj = await rf.json().catch(() => null);
      const next = rj?.data;
      if (rf.ok && next?.accessToken) {
        token = next.accessToken;
        saveSession(stateDir, {
          accessToken: next.accessToken,
          refreshToken: next.refreshToken ?? session.refreshToken,
          username: session.username,
        });
        log?.("multi-agent: access token refreshed");
        res = await doFetch(token);
      }
    } catch (err: any) {
      log?.(`multi-agent: token refresh failed: ${err?.message ?? err}`);
    }
  }

  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = json?.error?.message ?? json?.message ?? text.slice(0, 200);
    const err = new Error(`${pathname} -> HTTP ${res.status}: ${msg}`);
    (err as any).status = res.status;
    throw err;
  }
  return json;
}

/** 把桥返回的会话列表映射成模型好读的字段（兼容 title 在 projections.values.title）。 */
function mapSessions(raw: any[]): Array<Record<string, unknown>> {
  return (Array.isArray(raw) ? raw : []).map((s: any) => {
    const values = s?.projections?.values ?? {};
    const title =
      (typeof values.title === "string" && values.title) ||
      (typeof s?.title === "string" && s.title) ||
      "(未命名)";
    return {
      sessionId: String(s?.sessionId ?? ""),
      title,
      /** 项目所在文件夹：新建会话/复用会话都要靠它 */
      cwd: typeof s?.cwd === "string" ? s.cwd : "",
      running: s?.running === true,
      updatedAt: typeof s?.updatedAt === "number" ? s.updatedAt : 0,
    };
  });
}

/** 从会话历史里取最后一条 assistant 文本（副 Agent 的"最终报告"）。
 *  ⚠ 桥下行的事件是**信封** `{ event: {type,data}, seq }`，不是扁平 `{type,data}`。 */
function lastAssistantText(items: any[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const e = items[i]?.event ?? items[i];
    if (e?.type !== "assistant/message") continue;
    const content = e?.data?.message?.content ?? e?.data?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/** 跨机能力默认**开启**；只有显式写 `{"enabled":false}` 才关闭。 */
export function crossMachineEnabled(stateDir: string): boolean {
  const cfgPath = path.join(stateDir, "multi-agent.json");
  if (!existsSync(cfgPath)) return true;
  try {
    return readJson(cfgPath)?.enabled !== false;
  } catch {
    return true;
  }
}

export function setCrossMachineEnabled(stateDir: string, enabled: boolean): void {
  try {
    writeFileSync(path.join(stateDir, "multi-agent.json"), JSON.stringify({ enabled }));
  } catch (err: any) {
    /* 写不进去时下次启动仍按旧状态；调用方负责提示 */
    void err;
  }
}

let installed = false;
const disposers: Array<() => void> = [];

/** 注销全部跨机工具（面板"关闭"或插件卸载时调用）。 */
export function disposeMultiAgent(): void {
  for (const d of disposers.splice(0)) {
    try {
      d();
    } catch {
      /* 单个 dispose 失败不影响其它 */
    }
  }
  installed = false;
}

export function isMultiAgentInstalled(): boolean {
  return installed;
}

export function installMultiAgent(ctx: any, deps: Deps): boolean {
  if (installed) return true;
  if (!crossMachineEnabled(deps.stateDir)) return false;
  const cfg = existsSync(path.join(deps.stateDir, "multi-agent.json"))
    ? readJson(path.join(deps.stateDir, "multi-agent.json"))
    : null;

  const relayUrl = String(cfg?.relayUrl || relayFromConfig(deps.stateDir) || "").replace(/\/$/, "");
  if (!relayUrl) {
    deps.log("multi-agent: relayUrl missing; tools not installed");
    return false;
  }

  /** 一次跨机 RPC（relay 代理 → 桥），统一超时与错误。 */
  const rpc = (deviceId: string, type: string, payload: unknown = {}, timeoutMs = 20_000): Promise<any> =>
    relayJson(
      deps.stateDir,
      relayUrl,
      `/devices/${encodeURIComponent(deviceId)}/rpc`,
      { method: "POST", body: { type, payload, timeoutMs } },
      deps.log,
    );

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** 幂等键 → jobId（进程内；插件重启后失效，符合 MVP 预期）。 */
  const idem = new Map<string, string>();

  const install = (c: any) => {
    try {
      const tools = c?.get?.("tools") ?? c?.tools;
      // ⚠ cordis 服务属性的直接访问受 inject 约束（`ctx.jobs` 未注入会抛 "cannot get property"）；
      //   这里统一用 `c.get("jobs")` 取句柄。
      const jobs = c?.get?.("jobs") ?? c?.jobs;
      /** 用于软超时提醒主 Agent。⚠ `c.get(name)` 也受 inject 约束：未注入时抛错，
       *  所以必须 try/catch —— agents 只是增强项，不能让它拖垮整个工具注册。 */
      let agents: any;
      try {
        agents = c?.get?.("agents") ?? c?.agents;
      } catch {
        agents = undefined;
      }
      if (!tools?.register) {
        deps.log("multi-agent: tools service unavailable; tools not installed");
        return;
      }
      if (!jobs?.start) {
        deps.log("multi-agent: jobs service unavailable; agent_run not installed");
      }
      /** 统一登记 disposer，面板关闭时能整体注销。 */
      const reg = (def: any) => {
        const d = tools.register(def);
        disposers.push(d);
        return d;
      };

      reg({
        name: "computers_list",
        description:
          "List the computers (DSH hosts) under this relay account, with online status. Use the returned deviceId or label as the `computer` argument of other cross-machine tools.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        output: { schema: { type: "array" }, render: (_a: any, v: any) => [{ type: "text", text: JSON.stringify(v) }] },
        execute: async () => {
          const j = await relayJson(deps.stateDir, relayUrl, "/devices", {}, deps.log);
          const list = Array.isArray(j?.data) ? j.data : [];
          return list.map((d: any) => ({
            deviceId: String(d?.id ?? d?.deviceId ?? ""),
            label: String(d?.label ?? ""),
            platform: String(d?.platform ?? ""),
            status: String(d?.status ?? ""),
            lastSeenAt: d?.lastSeenAt ?? null,
          }));
        },
      });

      reg({
        name: "sessions_list",
        description:
          "List conversations of one of this account's computers. Pass `computer` as a deviceId (preferred) or a unique label from computers_list.",
        parameters: {
          type: "object",
          properties: {
            computer: { type: "string", description: "deviceId or unique computer label" },
            limit: { type: "number", description: "Max sessions to return (default 50, newest first)" },
          },
          required: ["computer"],
        },
        output: { schema: { type: "object" }, render: (_a: any, v: any) => [{ type: "text", text: JSON.stringify(v) }] },
        execute: async (args: any) => {
          const wanted = String(args?.computer ?? "").trim();
          if (!wanted) throw new Error("computer is required");

          const devJson = await relayJson(deps.stateDir, relayUrl, "/devices", {}, deps.log);
          const devices: any[] = Array.isArray(devJson?.data) ? devJson.data : [];
          const byId = devices.find((d) => String(d?.id ?? d?.deviceId) === wanted);
          const byLabel = devices.filter((d) => String(d?.label ?? "").toLowerCase() === wanted.toLowerCase());
          const device = byId ?? (byLabel.length === 1 ? byLabel[0] : null);
          if (!device) {
            const labels = devices.map((d) => `${String(d?.label ?? "")}(${String(d?.id ?? "")})`);
            throw new Error(
              byLabel.length > 1
                ? `computer label "${wanted}" is ambiguous; use deviceId: ${labels.join(", ")}`
                : `computer not found: ${wanted}; available: ${labels.join(", ")}`,
            );
          }
          const deviceId = String(device.id ?? device.deviceId);

          const j = await relayJson(
            deps.stateDir,
            relayUrl,
            `/devices/${encodeURIComponent(deviceId)}/rpc`,
            { method: "POST", body: { type: "sessions.list", payload: {}, timeoutMs: 15_000 } },
            deps.log,
          );
          // relay 包裹：{ok,data:{ok,data:{sessions}}}；兼容桥直接返回 {ok,data}
          const inner = j?.data ?? j;
          const all = mapSessions(inner?.data?.sessions ?? inner?.sessions ?? []);
          const limitRaw = Number(args?.limit);
          const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 50;
          all.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
          return {
            computer: { deviceId, label: String(device.label ?? "") },
            total: all.length,
            sessions: all.slice(0, limit),
          };
        },
      });

      reg({
        name: "agent_run",
        description:
          "Run a prompt on another computer of this account as a background job and collect that conversation's final answer. Returns a jobId; when the job settles you get a completion notice — read the report with job_output.",
        parameters: {
          type: "object",
          properties: {
            computer: { type: "string", description: "deviceId or unique computer label" },
            prompt: { type: "string", description: "Instruction for the remote agent" },
            sessionId: { type: "string", description: "Reuse this conversation; omit to create a new one (cwd required)" },
            cwd: { type: "string", description: "Project folder for a new conversation" },
            idemKey: {
              type: "string",
              description: "Idempotency key: the same key returns the existing job instead of dispatching again",
            },
            softTimeoutMs: {
              type: "number",
              description:
                "Soft timeout in ms (default 30 min). When reached the job keeps running and the main agent gets a notice to check in, then decides to keep waiting or call job_kill.",
            },
            depth: {
              type: "number",
              description:
                "Chain depth (default 0). Remote agents must pass depth+1 when they delegate again; values above 3 are refused.",
            },
            chain: {
              type: "string",
              description:
                "Comma-separated deviceId:sessionId entries already visited in this delegation chain; a target already present is refused.",
            },
          },
          required: ["computer", "prompt"],
        },
        output: { schema: { type: "object" }, render: (_a: any, v: any) => [{ type: "text", text: JSON.stringify(v) }] },
        execute: async (args: any, exec: any) => {
          const wanted = String(args?.computer ?? "").trim();
          const prompt = String(args?.prompt ?? "").trim();
          if (!wanted || !prompt) throw new Error("computer and prompt are required");
          const reuse = typeof args?.sessionId === "string" && args.sessionId.trim() ? args.sessionId.trim() : "";
          const cwd = typeof args?.cwd === "string" ? args.cwd.trim() : "";
          if (!reuse && !cwd) throw new Error("provide sessionId (reuse) or cwd (create)");
          // 软超时：只用于"提醒主 Agent 来看"，不终止任务（agent 本身可能有长任务）
          const softTimeoutMs = Math.min(
            Math.max(Number(args?.softTimeoutMs) || 1_800_000, 10_000),
            86_400_000,
          );

          const devJson = await relayJson(deps.stateDir, relayUrl, "/devices", {}, deps.log);
          const devices: any[] = Array.isArray(devJson?.data) ? devJson.data : [];
          const byId = devices.find((d) => String(d?.id ?? d?.deviceId) === wanted);
          const byLabel = devices.filter((d) => String(d?.label ?? "").toLowerCase() === wanted.toLowerCase());
          const device = byId ?? (byLabel.length === 1 ? byLabel[0] : null);
          if (!device) throw new Error(`computer not found or ambiguous: ${wanted}`);
          const deviceId = String(device.id ?? device.deviceId);

          // 防环：depth 上限 3；目标已在 chain 里则拒绝
          const depth = Math.max(0, Math.floor(Number(args?.depth) || 0));
          if (depth > 3) throw new Error("multi-agent chain depth limit reached (max 3)");
          const chainKeys = String(args?.chain ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          const targetKey = `${deviceId}:${reuse || "new"}`;
          if (chainKeys.includes(targetKey) || chainKeys.includes(`${deviceId}:new`)) {
            throw new Error(
              `multi-agent cycle detected: ${targetKey} already in chain (${chainKeys.join(",")})`,
            );
          }

          const owner = String(exec?.agent?.id ?? "");
          if (!owner) throw new Error("no owning session for the background job");

          // 并发上限：每个主会话同时最多 2 个 remote-agent job
          try {
            const active = (jobs.list?.(owner) ?? []).filter(
              (j: any) =>
                String(j.kind) === "remote-agent" &&
                ["running", "stopping"].includes(String(j.status)),
            );
            if (active.length >= 2) {
              throw new Error(
                `too many active remote jobs for this session (max 2): ${active
                  .map((j: any) => String(j.id))
                  .join(", ")}`,
              );
            }
          } catch (err: any) {
            if (/too many active/.test(String(err?.message ?? err))) throw err;
          }

          // 幂等：同 idemKey 且任务仍存活 → 返回原 jobId，避免重复派发把远端跑两遍
          const idemKey = typeof args?.idemKey === "string" ? args.idemKey.trim() : "";
          if (idemKey) {
            const prev = idem.get(idemKey);
            if (prev) {
              let alive = false;
              try {
                alive = (jobs.list?.(owner) ?? []).some((j: any) => String(j.id) === prev);
              } catch {
                alive = false;
              }
              if (alive) {
                return {
                  jobId: prev,
                  reused: true,
                  computer: { deviceId, label: String(device.label ?? "") },
                  sessionId: null,
                };
              }
              idem.delete(idemKey);
            }
          }
          let activeSid = reuse;

          const jobId = jobs.start({
            owner,
            kind: "remote-agent",
            label: `remote-agent → ${String(device.label ?? deviceId)}`,
            run: (handle: any) => {
              const ac = new AbortController();
              const done = (async () => {
                try {
                  if (!activeSid) {
                    const cj = await rpc(deviceId, "sessions.create", { cwd });
                    const innerC = cj?.data ?? cj;
                    activeSid = String(innerC?.data?.sessionId ?? innerC?.sessionId ?? "");
                    if (!activeSid) throw new Error("sessions.create returned no sessionId");
                    handle.append(`[session] ${activeSid} (${cwd})\n`);
                  } else {
                    handle.append(`[session] reuse ${activeSid}\n`);
                  }
                  // 基线：复用会话时历史里可能已有旧回复 → 只认 seq 大于基线的新消息
                  const baseHistory = await rpc(deviceId, "sessions.history", {
                    sessionId: activeSid,
                    maxMessages: 1,
                  }).catch(() => null);
                  const innerB = baseHistory?.data ?? baseHistory;
                  const baseEvents: any[] = innerB?.data?.events ?? innerB?.events ?? [];
                  const baseSeq = baseEvents.reduce((m, e) => Math.max(m, Number(e?.seq) || 0), 0);

                  const chainEntry = `${deviceId}:${activeSid}`;
                  const marker =
                    `\n\n[multi-agent] depth=${depth + 1} chain=${[...chainKeys, chainEntry].join(",")}` +
                    `\n（若你要继续派活给其它电脑，请把本行原样传给 agent_run 的 depth/chain 参数）`;
                  await rpc(deviceId, "sessions.run", {
                    sessionId: activeSid,
                    content: [{ type: "text", text: prompt + marker }],
                  });
                  handle.append("[dispatch] accepted; waiting for turn to finish…\n");

                  const dispatchedAt = Date.now();
                  let softNotified = false;
                  let consecutiveErrors = 0;
                  // ⚠ 事件驱动：只认 history 里 seq>baseSeq 的 turn/end。
                  //   网络抖动（409/超时/瞬时缺行）**不**当作任务失败，累计到阈值才报 remote-unreachable。
                  while (true) {
                    if (ac.signal.aborted) {
                      await rpc(deviceId, "sessions.interrupt", { sessionId: activeSid }).catch(() => {});
                      return { status: "failed", detail: "cancelled" };
                    }
                    if (!softNotified && Date.now() - dispatchedAt >= softTimeoutMs) {
                      softNotified = true;
                      const softLabel =
                        softTimeoutMs >= 60_000
                          ? `${Math.round(softTimeoutMs / 60_000)} 分钟`
                          : `${Math.round(softTimeoutMs / 1000)} 秒`;
                      handle.updateProgress(`soft timeout after ${softLabel}; still running`);
                      try {
                        const ownerAgent = agents?.get?.(owner);
                        if (ownerAgent?.inject) {
                          ownerAgent.inject({
                            id: randomUUID(),
                            role: "user",
                            content: [
                              {
                                type: "text",
                                text: `[remote-agent] 远端任务已运行超过 ${softLabel}，仍在进行（会话 ${activeSid}）。你可以继续等待，或调用 job_kill 取消。`,
                              },
                            ],
                            source: { kind: "multi-agent", form: "notice" },
                          });
                        } else {
                          handle.append(`[soft-timeout] ${softLabel} elapsed; still running\n`);
                        }
                      } catch (err: any) {
                        handle.append(`[soft-timeout] notify failed: ${String(err?.message ?? err)}\n`);
                      }
                    }
                    await sleep(2000);

                    let events: any[] = [];
                    try {
                      const hj = await rpc(deviceId, "sessions.history", {
                        sessionId: activeSid,
                        maxMessages: 12,
                      });
                      const innerH = hj?.data ?? hj;
                      events = innerH?.data?.events ?? innerH?.events ?? [];
                      consecutiveErrors = 0;
                    } catch (err: any) {
                      consecutiveErrors += 1;
                      const msg = String(err?.message ?? err);
                      const offline = /device is offline|HTTP 409/i.test(msg);
                      handle.updateProgress(
                        `${offline ? "device offline" : "history error"} x${consecutiveErrors}; waiting`,
                      );
                      if (consecutiveErrors >= 15) {
                        return { status: "failed", detail: `remote-unreachable: ${msg}` };
                      }
                      continue;
                    }

                    const fresh = events.filter((e) => Number(e?.seq) > baseSeq);
                    const endItem = [...fresh].reverse().find((e) => (e?.event ?? e)?.type === "turn/end");
                    if (!endItem) {
                      const partial = lastAssistantText(fresh);
                      if (partial) {
                        handle.updateProgress(`running; last: ${partial.slice(0, 60).replace(/\s+/g, " ")}`);
                      }
                      continue;
                    }

                    const endEv = endItem?.event ?? endItem;
                    const reason = String(endEv?.data?.reason?.kind ?? "unknown");
                    const report = lastAssistantText(fresh);
                    if (report) handle.append("\n" + report);
                    if (reason === "completed") {
                      if (!report) handle.append("\n(本轮没有文本回复)");
                      return { status: "completed" };
                    }
                    return { status: "failed", detail: `turn-${reason}` };
                  }
                } catch (err: any) {
                  return { status: "failed", detail: String(err?.message ?? err) };
                }
              })();
              return {
                cancel: () => {
                  ac.abort();
                  if (activeSid) rpc(deviceId, "sessions.interrupt", { sessionId: activeSid }).catch(() => {});
                },
                done,
              };
            },
          });

          if (idemKey) idem.set(idemKey, String(jobId));
          return { jobId, computer: { deviceId, label: String(device.label ?? "") }, sessionId: activeSid || null };
        },
      });

      const resolveDevice = async (wanted: string) => {
        const devJson = await relayJson(deps.stateDir, relayUrl, "/devices", {}, deps.log);
        const devices: any[] = Array.isArray(devJson?.data) ? devJson.data : [];
        const byId = devices.find((d) => String(d?.id ?? d?.deviceId) === wanted);
        const byLabel = devices.filter((d) => String(d?.label ?? "").toLowerCase() === wanted.toLowerCase());
        const device = byId ?? (byLabel.length === 1 ? byLabel[0] : null);
        if (!device) throw new Error(`computer not found or ambiguous: ${wanted}`);
        return { deviceId: String(device.id ?? device.deviceId), label: String(device.label ?? "") };
      };
      const unwrap = (j: any) => {
        const a = j?.data ?? j;
        return a?.data ?? a;
      };

      reg({
        name: "remote_jobs",
        description:
          "List background jobs of a conversation on another computer. Needs the updated bridge on that computer; older bridges answer unsupported.",
        parameters: {
          type: "object",
          properties: {
            computer: { type: "string", description: "deviceId or unique label" },
            sessionId: { type: "string", description: "Target conversation id" },
          },
          required: ["computer", "sessionId"],
        },
        output: { schema: { type: "object" }, render: (_a: any, v: any) => [{ type: "text", text: JSON.stringify(v) }] },
        execute: async (args: any) => {
          const wanted = String(args?.computer ?? "").trim();
          const sid = String(args?.sessionId ?? "").trim();
          if (!wanted || !sid) throw new Error("computer and sessionId are required");
          const { deviceId, label } = await resolveDevice(wanted);
          const j = await rpc(deviceId, "jobs.list", { sessionId: sid });
          return { computer: { deviceId, label }, jobs: unwrap(j)?.jobs ?? [] };
        },
      });

      reg({
        name: "remote_job_output",
        description:
          "Read retained output of one background job on another computer, from a byte offset (default 0). Returns {job, text, status}.",
        parameters: {
          type: "object",
          properties: {
            computer: { type: "string" },
            sessionId: { type: "string" },
            jobId: { type: "string" },
            offset: { type: "number", description: "Byte offset to resume from; default 0" },
          },
          required: ["computer", "sessionId", "jobId"],
        },
        output: { schema: { type: "object" }, render: (_a: any, v: any) => [{ type: "text", text: JSON.stringify(v) }] },
        execute: async (args: any) => {
          const wanted = String(args?.computer ?? "").trim();
          const sid = String(args?.sessionId ?? "").trim();
          const jobId = String(args?.jobId ?? "").trim();
          if (!wanted || !sid || !jobId) throw new Error("computer, sessionId and jobId are required");
          const { deviceId, label } = await resolveDevice(wanted);
          const j = await rpc(deviceId, "jobs.follow", {
            sessionId: sid,
            jobId,
            offset: Number(args?.offset) || 0,
          });
          return { computer: { deviceId, label }, ...unwrap(j) };
        },
      });

      reg({
        name: "remote_job_kill",
        description: "Kill a background job on another computer (newer bridges only).",
        parameters: {
          type: "object",
          properties: {
            computer: { type: "string" },
            sessionId: { type: "string" },
            jobId: { type: "string" },
            reason: { type: "string" },
          },
          required: ["computer", "sessionId", "jobId"],
        },
        output: { schema: { type: "object" }, render: (_a: any, v: any) => [{ type: "text", text: JSON.stringify(v) }] },
        execute: async (args: any) => {
          const wanted = String(args?.computer ?? "").trim();
          const sid = String(args?.sessionId ?? "").trim();
          const jobId = String(args?.jobId ?? "").trim();
          if (!wanted || !sid || !jobId) throw new Error("computer, sessionId and jobId are required");
          const { deviceId, label } = await resolveDevice(wanted);
          const j = await rpc(deviceId, "jobs.kill", {
            sessionId: sid,
            jobId,
            ...(typeof args?.reason === "string" ? { reason: args.reason } : {}),
          });
          return { computer: { deviceId, label }, killed: true, result: unwrap(j) };
        },
      });

      installed = true;
      deps.log("multi-agent: tools registered (computers_list, sessions_list, agent_run)");
    } catch (err: any) {
      deps.log(`multi-agent: registration failed: ${err?.message ?? err}`);
    }
  };

  try {
    // agents 是软超时提醒用的；它是 DSH 核心服务，正常组合里一定存在。
    if (typeof ctx.inject === "function") ctx.inject(["tools", "jobs", "agents"], install);
    else install(ctx);
  } catch (err: any) {
    deps.log(`multi-agent: inject failed: ${err?.message ?? err}`);
    return false;
  }
  return true;
}
