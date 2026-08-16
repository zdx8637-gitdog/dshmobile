import paramiko, sys, os
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SRV = os.environ.get("RELAY_HOST", "")
USER = "ubuntu"
PASS = os.environ.get("RELAY_SSH_PASS", "")
WEB_ROOT = "/opt/session-control-relay/web/dsh-debug"

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(SRV, username=USER, password=PASS, timeout=15)
sftp = c.open_sftp()

# 建目录并上传单文件 UI
try:
    sftp.stat(WEB_ROOT)
except FileNotFoundError:
    sftp.mkdir(WEB_ROOT)

local = r"D:\p\dsh-remote\web\index.html"
sftp.put(local, f"{WEB_ROOT}/index.html")
print("uploaded ->", f"{WEB_ROOT}/index.html")

# 校验 nginx 能取到
stdin, stdout, stderr = c.exec_command(f"curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1/dsh-debug/")
print("local nginx status:", stdout.read().decode().strip())
sftp.close()
c.close()
