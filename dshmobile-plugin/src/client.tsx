// @liustack/dshmobile-bridge · client 半边
// 设置页「插件」tab 下的一张卡：桥状态、连接配置（可编辑保存）、
// 扫码配对（二维码 + 6 位码 + 倒计时 + 刷新）。数据面 = settings 命名空间
// `dshmobile`（宿主半边写桥状态与配对码，卡片经 settingsScope 读写）。
import * as React from "react";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-runtime/client";
// qrcode-generator 会被构建进本 bundle（非 external）
import * as qrcode from "qrcode-generator";

const NS = "dshmobile";

export const inject = ["slots", "settingsScope"];

interface CardSnapshot {
  status: string;
  writable: boolean;
  value: {
    enabled?: boolean;
    relayUrl?: string;
    username?: string;
    password?: string;
    deviceLabel?: string;
    pairingCode?: string;
    pairingExpiresAt?: string;
    bridgeStatus?: string;
    registerError?: string;
    pairError?: string;
    mode?: string;
    grantPairingId?: string;
  } | null;
  actions?: {
    refreshPairing: () => Promise<void>;
    save: (patch: Record<string, unknown>) => Promise<void>;
    register: (req: { username: string; password: string }) => Promise<void>;
  };
}

function drawQr(canvas: HTMLCanvasElement, text: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  if (!text) {
    ctx.fillStyle = "#0f1115";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return;
  }
  try {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const cell = Math.floor(canvas.width / (n + 4));
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#0f1115";
    const off = Math.floor((canvas.width - n * cell) / 2);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(off + c * cell, off + r * cell, cell, cell);
      }
    }
  } catch {
    /* 无效数据则留白 */
  }
}

const labelStyle: React.CSSProperties = { fontSize: 12, color: "#8b8e98", marginBottom: 4 };
const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", background: "#17181c", border: "1px solid #2a2c33",
  borderRadius: 6, color: "#e6e7ea", padding: "6px 10px", fontSize: 13,
};
const btnStyle: React.CSSProperties = {
  background: "#2f6fed", color: "#fff", border: "none", borderRadius: 6,
  padding: "6px 14px", fontSize: 13, cursor: "pointer",
};

function DshmobileCard(props: any) {
  const snap = props.useDshmobileCard((s: CardSnapshot) => s);
  const value = snap?.value ?? {};
  const [form, setForm] = React.useState<Record<string, string> | null>(null);
  const [left, setLeft] = React.useState(-1);
  const [localError, setLocalError] = React.useState("");
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  // 表单与宿主值同步（仅初始化一次，避免覆盖用户输入）
  React.useEffect(() => {
    if (value && form === null) {
      setForm({
        relayUrl: value.relayUrl ?? "",
        username: value.username ?? "",
        password: value.password ?? "",
        deviceLabel: value.deviceLabel ?? "",
      });
    }
  }, [value, form]);

  // 二维码渲染：常驻——pair 模式=手机登录（方向一）；grant 模式=手机授权本机（方向二）
  React.useEffect(() => {
    if (canvasRef.current) {
      const relay = ((form?.relayUrl || value.relayUrl || "").trim()).replace(/\/$/, "");
      const code = value.pairingCode || "";
      const mode = value.mode === "grant" ? "grant" : "pair";
      let url = "";
      if (code) {
        url =
          mode === "grant"
            ? `${relay}/dshmobile/?mode=grant&code=${encodeURIComponent(code)}&pid=${encodeURIComponent(value.grantPairingId ?? "")}`
            : `${relay}/dshmobile/?mode=pair&code=${encodeURIComponent(code)}`;
      }
      drawQr(canvasRef.current, url);
    }
  }, [value.pairingCode, value.pairingExpiresAt, value.mode, value.grantPairingId, value.relayUrl, form]);

  // 配对码倒计时
  React.useEffect(() => {
    if (!value.pairingExpiresAt) {
      setLeft(-1);
      return;
    }
    const tick = () => {
      const ms = new Date(value.pairingExpiresAt as string).getTime() - Date.now();
      setLeft(Math.max(0, Math.round(ms / 1000)));
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [value.pairingExpiresAt]);

  // 编辑时以「已保存值 + 草稿」兜底：form 可能因初始化时序只含部分字段
  const edit = (k: string, v: string) =>
    setForm((f) => ({
      relayUrl: (value as any)?.relayUrl ?? "",
      username: (value as any)?.username ?? "",
      password: (value as any)?.password ?? "",
      deviceLabel: (value as any)?.deviceLabel ?? "",
      ...(f ?? {}),
      [k]: v,
    }));
  // 动作一律走 hooks store（已验证通道），不依赖顶层 props 透传
  const actions = snap?.actions ?? {};
  const save = async () => {
    if (!form) return;
    const patch: Record<string, unknown> = {};
    for (const k of ["relayUrl", "username", "password", "deviceLabel"]) {
      const cur = (value as any)?.[k] ?? "";
      if (form[k] !== cur) patch[k] = form[k].trim();
    }
    if (Object.keys(patch).length > 0) {
      try { await actions.save(patch); } catch (e) { setLocalError(String(e)); }
    }
  };
  // 注册并连接：先校验 → 落表单 → 写 registerRequest 触发宿主调 /auth/register
  const register = async () => {
    setLocalError("");
    const u = ((form?.username ?? (value as any)?.username) ?? "").trim();
    const p = (form?.password ?? (value as any)?.password) ?? "";
    if (u.length < 3) { setLocalError("账号至少 3 个字符（字母/数字/下划线/横线）"); return; }
    if (p.length < 6) { setLocalError("密码至少 6 位"); return; }
    await save();
    try {
      await actions.register({ username: u, password: p });
    } catch (e) { setLocalError(String(e)); }
  };
  // 刷新二维码：两种模式都可用，无需账号前置（未登录=授权码，已登录=登录码）
  const genPairing = async () => {
    setLocalError("");
    try {
      await actions.refreshPairing();
    } catch (e) { setLocalError(String(e)); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "14px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: "#e6e7ea" }}>DSH Mobile 远程桥接</span>
        <span
          style={{
            fontSize: 11, color: value?.bridgeStatus === "running" ? "#4ade80" : "#8b8e98",
            background: "#1c1e24", borderRadius: 999, padding: "2px 10px",
          }}
        >
          桥状态：{value?.bridgeStatus ?? "unknown"}
        </span>
      </div>
      <p style={{ margin: 0, fontSize: 11, color: "#55585f" }}>
        debug: scope={snap?.status} writable={String(snap?.writable)} actions={Object.keys(actions).join(",") || "无"}
        {localError ? ` · ${localError}` : ""}
      </p>
      <p style={{ margin: 0, fontSize: 12, color: "#8b8e98" }}>
        让手机远程控制本机 DeepSeek Harness：填写 relay 账号后保存，桥自动启动；手机 App 扫码即可登录同一账号。
      </p>

      <div>
        <div style={labelStyle}>relay 地址</div>
        <input style={inputStyle} value={form?.relayUrl ?? (value as any)?.relayUrl ?? ""} onChange={(e) => edit("relayUrl", e.target.value)} />
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={labelStyle}>账号</div>
          <input style={inputStyle} value={form?.username ?? (value as any)?.username ?? ""} onChange={(e) => edit("username", e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={labelStyle}>密码</div>
          <input style={inputStyle} type="password" value={form?.password ?? (value as any)?.password ?? ""} onChange={(e) => edit("password", e.target.value)} />
        </div>
      </div>
      <div>
        <div style={labelStyle}>设备名（手机端显示）</div>
        <input style={inputStyle} value={form?.deviceLabel ?? (value as any)?.deviceLabel ?? ""} onChange={(e) => edit("deviceLabel", e.target.value)} />
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button style={btnStyle} onClick={save}>保存配置</button>
        <button
          style={{ ...btnStyle, background: "#1c1e24", border: "1px solid #2f6fed", color: "#9db8f5" }}
          onClick={register}
        >
          注册并连接
        </button>
        {value?.registerError ? (
          <span style={{ fontSize: 12, color: "#f87171" }}>{value.registerError}</span>
        ) : null}
      </div>
      <p style={{ margin: 0, fontSize: 11, color: "#8b8e98" }}>
        没有账号？填好账号密码后点「注册并连接」，relay 上会创建新账号并自动启动桥。
      </p>

      <div style={{ borderTop: "1px solid #23252b", margin: "4px 0" }} />

      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
        <canvas ref={canvasRef} width={132} height={132} style={{ border: "1px solid #2a2c33", borderRadius: 8 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 5, color: "#e6e7ea" }}>
            {value?.pairingCode || "------"}
          </div>
          <div style={{ fontSize: 12, color: "#8b8e98" }}>
            {value?.mode === "grant"
              ? left > 0 ? `等待手机授权（剩余 ${left} 秒）——手机 App 已登录时扫码即授权本机` : "点击右侧按钮生成授权二维码"
              : left < 0 ? "点击右侧按钮生成登录二维码" : left > 0 ? `剩余 ${left} 秒` : "已过期，请重新生成"}
          </div>
          <button style={btnStyle} onClick={genPairing}>刷新二维码</button>
          {value?.pairError ? (
            <span style={{ fontSize: 12, color: "#f87171" }}>{value.pairError}</span>
          ) : null}
        </div>
      </div>
      <p style={{ margin: 0, fontSize: 12, color: "#8b8e98" }}>
        手机安装 DSH Mobile App 后，扫描二维码或输入配对码即可登录同一账号（无需密码）。
      </p>
    </div>
  );
}

export function apply(ctx: any) {
  const scope = ctx.settingsScope.bind({ namespace: NS });

  // 动作放在 store 里（hooks 是已验证的透传通道）；错误上抛给卡片显示
  const actions = {
    refreshPairing: () =>
      scope.set("refreshPairing", true).catch((e: unknown) => { throw e; }),
    save: (patch: Record<string, unknown>) =>
      Promise.all(Object.entries(patch).map(([k, v]) => scope.set(k, v))).catch(
        (e: unknown) => { throw e; },
      ),
    register: (req: { username: string; password: string }) =>
      scope.set("registerRequest", JSON.stringify(req)).catch((e: unknown) => { throw e; }),
  };

  const store = createSnapshotStore<CardSnapshot>({
    status: "loading",
    writable: false,
    value: null,
    actions,
  });

  const publish = () => {
    const snap = scope.getSnapshot() as any;
    store.set({
      status: snap?.status ?? "unavailable",
      writable: snap?.writable ?? false,
      value: (snap?.value ?? null) as any,
      actions,
    });
  };
  publish();
  const off = scope.subscribe(publish);

  ctx.slots.inject("settings.plugin.item", function* () {
    yield ctx.slots.register(
      {
        name: "settings.plugin.item",
        id: "dshmobile",
        order: 30,
        inject: () => ({
          hooks: { dshmobileCard: store },
        }),
      },
      DshmobileCard,
    );
  });

  return () => {
    off();
  };
}
