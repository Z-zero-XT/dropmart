# 部署说明

服务本身是一个单文件 Node 程序，不监听 HTTPS、不做进程守护 —— 这些交给 Nginx / systemd / Docker
更合适。

## 一、Docker Compose（推荐）

```bash
cp .env.example .env
```

编辑 `.env`，至少改掉这三项：

```
ADMIN_PASSWORD=一个足够长的随机密码
APP_SECRET=用 openssl rand -hex 32 生成的值
PUBLIC_URL=https://shop.example.com
```

然后：

```bash
docker compose up -d
docker compose logs -f
```

`docker-compose.yml` 已经把 `./data` 挂成持久卷，容器重建不会丢订单和卡密。

想改商品配置又不想重建镜像，把 `./config` 也挂上（compose 文件里已注释好）。
注意挂成只读的话，后台的「改价 / 上下架 / 导入卡密」会写入失败 —— 需要这些功能就不要加 `:ro`。

## 二、直接跑 + systemd

```bash
sudo useradd -r -s /usr/sbin/nologin dropmart
sudo mkdir -p /opt/dropmart
sudo rsync -a --exclude data --exclude .git ./ /opt/dropmart/
sudo chown -R dropmart:dropmart /opt/dropmart
```

`/etc/systemd/system/dropmart.service`：

```ini
[Unit]
Description=DropMart storefront
After=network.target

[Service]
Type=simple
User=dropmart
WorkingDirectory=/opt/dropmart

Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=8787
Environment=PUBLIC_URL=https://shop.example.com
Environment=ADMIN_PASSWORD=替换成你的强密码
Environment=APP_SECRET=替换成随机值

ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

# 加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/dropmart/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dropmart
sudo systemctl status dropmart
```

因为 `HOST=127.0.0.1`，服务只在本机可访问，必须通过反向代理暴露 —— 这也是推荐的做法。

## 三、Nginx 反向代理 + HTTPS

```nginx
server {
    listen 80;
    server_name shop.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name shop.example.com;

    ssl_certificate     /etc/letsencrypt/live/shop.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/shop.example.com/privkey.pem;

    # 订单号 + token 会出现在 URL 里，别让它们进日志
    access_log off;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

```bash
sudo certbot --nginx -d shop.example.com
```

### Caddy 版本（更短）

```
shop.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy 会自动申请并续期证书，两行就够了。

## 四、配置支付回调

用 `webhook` 支付驱动时，`PUBLIC_URL` 必须填成外部能访问的地址，因为系统会把它拼成回调地址
`{PUBLIC_URL}/api/pay/webhook` 传给网关。

在网关后台把异步通知地址填成同一个 URL。回调需要回传 `orderId`、`amount`、`sign`，
其中 `sign = HMAC-SHA256(secret, orderId + ":" + amount)`，`secret` 取自
`config/site.json` 的 `payment.drivers.webhook.secret` 或环境变量 `APP_SECRET`。

本地调试回调时，可以用 Cloudflare Tunnel 把本机暴露出去：

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

把拿到的临时域名设为 `PUBLIC_URL` 即可。

## 五、备份

需要备份的只有两样东西：

```bash
# 订单库
cp data/db.json /backup/db-$(date +%F).json

# 未售出的卡密
cp -r data/stock /backup/stock-$(date +%F)/
```

`db.json` 是纯文本 JSON，随时可以打开查看和手工修复。建议加一条 cron：

```cron
0 4 * * * cd /opt/dropmart && tar czf /backup/dropmart-$(date +\%F).tar.gz data/
```

## 六、日志与排错

服务只往 stdout 写两类内容：启动横幅（含安全提醒）和错误。用 `docker compose logs -f`
或 `journalctl -u dropmart -f` 查看。

| 现象 | 排查方向 |
| --- | --- |
| 后台进不去 | `ADMIN_PASSWORD` 是否设置；设置了要重启服务 |
| 支付回调不生效 | `PUBLIC_URL` 是否正确；网关回调地址是否填对；签名规则是否一致 |
| 自动发货提示「存量不足」 | 检查 `data/stock/*.txt`；后台商品页能看到实时剩余 |
| 上游发货一直失败 | 订单详情里的 `message` 会写明原因；也可点「重试自动发货」 |
| 页面样式没生效 | 反向代理是否透传了 `Content-Type`；浏览器缓存 |

## 七、扩容与限制

- 本服务是**单进程、单实例**设计，写锁只在进程内有效。**不要直接起多个实例指向同一份 `data/`**。
- 需要水平扩容时，先把 `src/store.js` 换成真正的数据库（见 `docs/architecture.md` 第五节），
  再把 `AdminAuth` 的内存会话换成 Redis。
- 静态资源可以交给 Nginx 直接返回，绕过 Node：

  ```nginx
  location ~* ^/(styles\.css|app\.js|favicon\.svg)$ {
      root /opt/dropmart/public;
      expires 7d;
  }
  ```
