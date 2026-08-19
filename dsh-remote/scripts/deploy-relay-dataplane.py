# -*- coding: utf-8 -*-
"""Data Plane 部署：上传 relay 改动 → 备份 dist → tsc 构建 → 重启 → 验证。"""
import paramiko, time

HOST = "146.56.197.38"
USER = "ubuntu"
PWD = "Rpbdqz123"
SRC = "/opt/session-control-relay/service"
ALT = "/home/ubuntu/session_control/services/relay"
FILES = [
    "src/config.ts",
    "src/app.ts",
    "src/index.ts",
    "src/ws/relay.ts",
    "src/services/transfer-service.ts",
    "src/routes/transfers.ts",
]

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, password=PWD, timeout=20)
sftp = c.open_sftp()
for f in FILES:
    local = f.replace("/", "\\")
    sftp.put(rf"D:\p\dshmobile-repo\relay\{local}", f"{SRC}/{f}")
    sftp.put(rf"D:\p\dshmobile-repo\relay\{local}", f"{ALT}/{f}")
    print("uploaded:", f)
sftp.close()

cmds = [
    f"cd {SRC} && cp -r dist dist.bak-dataplane-$(date +%Y%m%d-%H%M%S) && echo backup-ok",
    f"cd {SRC} && npm run build 2>&1 | tail -3 && echo build-ok",
    "echo 'Rpbdqz123' | sudo -S systemctl restart session-control-relay.service && echo restart-ok",
]
for cmd in cmds:
    _, out, err = c.exec_command(cmd, timeout=300)
    print("$", cmd[:80], "...")
    print(out.read().decode(), end="")
    e = err.read().decode()
    if e.strip():
        print("ERR:", e.strip()[:200])

time.sleep(3)
_, out, _ = c.exec_command("systemctl is-active session-control-relay.service && curl -s http://127.0.0.1:48730/health && echo && curl -s http://127.0.0.1:48730/relay/status", timeout=20)
print(out.read().decode())
c.close()
