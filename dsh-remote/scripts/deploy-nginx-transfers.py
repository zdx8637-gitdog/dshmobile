# -*- coding: utf-8 -*-
"""nginx 增加 /transfers 代理（Data plane 上传/下载），配置测试通过后 reload。"""
import paramiko

HOST = "146.56.197.38"
USER = "ubuntu"
PWD = "Rpbdqz123"
CONF = "/etc/nginx/sites-enabled/session-control-relay"

BLOCK = '''    location /transfers {
        proxy_pass http://127.0.0.1:48730;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 16m;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

'''

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, password=PWD, timeout=20)

# 读取 → 在 443 server（第二次出现的 /remote-web/）之前插入 transfers 块
sftp = c.open_sftp()
with sftp.open(CONF, "r") as f:
    content = f.read().decode()

marker = "    location /remote-web/ {"
idx = content.find(marker, content.find(marker) + 1)  # 第二次出现
if idx == -1:
    print("MARKER NOT FOUND")
    sftp.close()
    c.close()
    raise SystemExit(1)
content = content[:idx] + BLOCK + content[idx:]

# 备份 + 写回（sudo 写 /etc/nginx 需要 root）
bak = CONF + ".bak-transfers-" + __import__("time").strftime("%Y%m%d-%H%M%S")
cmds = [
    f"cp {CONF} {bak} && echo backup-ok",
]
for cmd in cmds:
    _, out, err = c.exec_command(cmd, timeout=20)
    print(out.read().decode().strip(), err.read().decode().strip()[:100])

with sftp.open("/tmp/session-control-relay.new", "w") as f:
    f.write(content)
sftp.close()

_, out, err = c.exec_command(
    f"echo '{PWD}' | sudo -S cp /tmp/session-control-relay.new {CONF} && "
    f"echo '{PWD}' | sudo -S nginx -t 2>&1 && "
    f"echo '{PWD}' | sudo -S systemctl reload nginx && echo reload-ok",
    timeout=60,
)
print(out.read().decode())
print("ERR:", err.read().decode()[:300])
c.close()
