// 直连 DSH mux（绕过 bridge）看 host 在连接时重放什么
const ws = new WebSocket("ws://127.0.0.1:3080/api/events.mux");
let count = 0;
ws.onmessage = (ev) => {
  const f = JSON.parse(ev.data);
  count++;
  if (count <= 40 || f?.payload?.type === "question/requested") {
    console.log(count, ":", JSON.stringify(f).slice(0, 220));
  }
};
ws.onopen = () => console.log("mux open");
setTimeout(() => { console.log("total frames:", count); ws.close(); process.exit(0); }, 8000);
