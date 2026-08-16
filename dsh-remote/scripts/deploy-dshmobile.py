# -*- coding: utf-8 -*-
"""发布落地页 + APK 到服务器 /dshmobile/（凭据走环境变量）。"""
import os, sys, paramiko

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
HOST = os.environ.get("RELAY_HOST", "")
USER = os.environ.get("RELAY_SSH_USER", "ubuntu")
PWD = os.environ.get("RELAY_SSH_PASS", "")
if not HOST or not PWD:
    print("用法：$env:RELAY_HOST / $env:RELAY_SSH_PASS 设置后运行")
    sys.exit(1)

WEB = "/opt/session-control-relay/web/dshmobile"
APK = r"D:\p\release\DSH-Mobile-0.1.0.apk"
HTML = r"D:\p\dsh-remote\web\dshmobile\index.html"

cli = paramiko.SSHClient()
cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cli.connect(HOST, username=USER, password=PWD, timeout=20)
sftp = cli.open_sftp()
try:
    sftp.stat(WEB)
except FileNotFoundError:
    sftp.mkdir(WEB)
sftp.put(HTML, f"{WEB}/index.html")
sftp.put(APK, f"{WEB}/DSH-Mobile-0.1.0.apk")
sftp.close()
_, out, _ = cli.exec_command(
    "curl -s -o /dev/null -w '%{http_code}' https://127.0.0.1/dshmobile/ -H 'Host: www.deepseek-claudex.cn'",
    timeout=30,
)
print("deployed, local check:", out.read().decode())
cli.close()
