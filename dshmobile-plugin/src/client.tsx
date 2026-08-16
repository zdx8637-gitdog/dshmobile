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
  } | null;
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

  // 二维码渲染
  React.useEffect(() => {
    if (canvasRef.current) {
      const relay = (form?.relayUrl || value.relayUrl || "").trim();
      const code = value.pairingCode || "";
      drawQr(
        canvasRef.current,
        code ? `dshmobile://pair?relay=${encodeURIComponent(relay)}&code=${encodeURIComponent(code)}` : "",
      );
    }
  }, [value.pairingCode, value.relayUrl, form]);

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

  const edit = (k: string, v: string) => setForm((f) => ({ ...(f ?? {}), [k]: v }));
  const save = async () => {
    if (!form) return;
    const patch: Record<string, unknown> = {};
    for (const k of ["relayUrl", "username", "password", "deviceLabel"]) {
      const cur = (value as any)?.[k] ?? "";
      if (form[k] !== cur) patch[k] = form[k].trim();
    }
    if (Object.keys(patch).length > 0) {
      try { await props.save(patch); } catch { /* 保存失败保持草稿 */ }
    }
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
      <p style={{ margin: 0, fontSize: 12, color: "#8b8e98" }}>
        让手机远程控制本机 DeepSeek Harness：填写 relay 账号后保存，桥自动启动；手机 App 扫码即可登录同一账号。
      </p>

      <div>
        <div style={labelStyle}>relay 地址</div>
        <input style={inputStyle} value={form?.relayUrl ?? ""} onChange={(e) => edit("relayUrl", e.target.value)} />
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={labelStyle}>账号</div>
          <input style={inputStyle} value={form?.username ?? ""} onChange={(e) => edit("username", e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={labelStyle}>密码</div>
          <input style={inputStyle} type="password" value={form?.password ?? ""} onChange={(e) => edit("password", e.target.value)} />
        </div>
      </div>
      <div>
        <div style={labelStyle}>设备名（手机端显示）</div>
        <input style={inputStyle} value={form?.deviceLabel ?? ""} onChange={(e) => edit("deviceLabel", e.target.value)} />
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button style={btnStyle} onClick={save}>保存配置</button>
      </div>

      <div style={{ borderTop: "1px solid #23252b", margin: "4px 0" }} />

      <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
        <canvas ref={canvasRef} width={132} height={132} style={{ border: "1px solid #2a2c33", borderRadius: 8 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 5, color: "#e6e7ea" }}>
            {value?.pairingCode || "------"}
          </div>
          <div style={{ fontSize: 12, color: "#8b8e98" }}>
            {left < 0 ? "点击右侧按钮生成配对码" : left > 0 ? `剩余 ${left} 秒` : "已过期，请重新生成"}
          </div>
          <button style={btnStyle} onClick={() => props.refreshPairing()}>生成配对码</button>
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
  const store = createSnapshotStore<CardSnapshot>({
    status: "loading",
    writable: false,
    value: null,
  });

  const publish = () => {
    const snap = scope.getSnapshot() as any;
    store.set({
      status: snap?.status ?? "unavailable",
      writable: snap?.writable ?? false,
      value: (snap?.value ?? null) as any,
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
          refreshPairing: () => scope.set("refreshPairing", true).catch(() => {}),
          save: (patch: Record<string, unknown>) => {
            const tasks = Object.entries(patch).map(([k, v]) => scope.set(k, v));
            return Promise.all(tasks).catch(() => {});
          },
        }),
      },
      DshmobileCard,
    );
  });

  return () => {
    off();
  };
}
