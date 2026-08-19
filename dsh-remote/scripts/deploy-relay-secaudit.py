# -*- coding: utf-8 -*-
"""relay 安全修复热部署：上传 src 改动 → 备份 dist → tsc 构建 → 重启 systemd → 验证。"""
import paramiko, time

HOST = "146.56.197.38"
USER = "ubuntu"
PWD = "Rpbdqz123"
SRC = "/opt/session-control-relay/service"
ALT = "/home/ubuntu/session_control/services/relay"
FILES = ["src/ws/relay.ts", "src/index.ts"]

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, password=PWD, timeout=20)
sftp = c.open_sftp()

for f in FILES:
    sftp.put(rf"D:\p\dshmobile-repo\relay\{f.replace('/', chr(92))}", f"{SRC}/{f}")
    sftp.put(rf"D:\p\dshmobile-repo\relay\{f.replace('/', chr(92))}", f"{ALT}/{f}")
    print("uploaded:", f)
sftp.close()

cmds = [
    f"cd {SRC} && cp -r dist dist.bak-secaudit-$(date +%Y%m%d-%H%M%S) && echo backup-ok",
    f"cd {SRC} && npm run build 2>&1 | tail -3 && echo build-ok",
    "systemctl restart session-control-relay.service && echo restart-ok",
]
for cmd in cmds:
    _, out, err = c.exec_command(cmd, timeout=300)
    print("$", cmd)
    print(out.read().decode(), end="")
    e = err.read().decode()
    if e:
        print("ERR:", e)

time.sleep(3)
_, out, _ = c.exec_command("systemctl is-active session-control-relay.service nginx", timeout=15)
print("is-active:", out.read().decode())
_, out, _ = c.exec_command("curl -s http://127.0.0.1:48730/health", timeout=15)
print("health:", out.read().decode())
_, out, _ = c.exec_command("curl -s http://127.0.0.1:48730/relay/status", timeout=15)
print("status:", out.read().decode())
_, out, _ = c.exec_command("journalctl -u session-control-relay.service --since '2 min ago' --no-pager | tail -8", timeout=15)
print("journal:", out.read().decode())
c.close()
