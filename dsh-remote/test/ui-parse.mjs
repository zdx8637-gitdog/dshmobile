// 解析 uiautomator dump：all = 打印全部节点；否则只打印有 text/content-desc 的节点
import { readFileSync } from "node:fs";
const xml = readFileSync(process.argv[2] ?? "D:/p/ui.xml", "utf8");
const all = process.argv[3] === "all";
const re = /<node[^>]*>/g;
let m;
const out = [];
while ((m = re.exec(xml))) {
  const tag = m[0];
  const grab = (name) => {
    const r = new RegExp(`${name}="([^"]*)"`).exec(tag);
    return r ? r[1] : "";
  };
  const text = grab("text");
  const desc = grab("content-desc");
  const cls = grab("class");
  const bounds = grab("bounds");
  const clickable = tag.includes('clickable="true"');
  if (all || text || desc) {
    out.push(`${clickable ? "[C]" : "   "} text=${JSON.stringify(text)} desc=${JSON.stringify(desc)} cls=${cls} ${bounds}`);
  }
}
console.log(out.join("\n") || "(no nodes)");
