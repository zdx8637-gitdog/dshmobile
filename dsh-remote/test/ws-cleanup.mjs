// 清理误注册的盘符根工作区（按 path 精确匹配 "D:\"）
const BASE = "http://127.0.0.1:3080";
async function unary(method, payload) {
  const resp = await fetch(`${BASE}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "wc-" + Math.random().toString(36).slice(2, 8), method, payload }),
  });
  return (await resp.json()).result;
}
const list = await unary("workspace.list", {});
const root = (list.value?.items ?? []).find((w) => w.path === "D:\\");
if (root) {
  const del = await unary("workspace.delete", { workspaceId: root.workspaceId });
  console.log("deleted D:\\ workspace:", JSON.stringify(del));
} else {
  console.log("no D:\\ workspace to clean");
}
