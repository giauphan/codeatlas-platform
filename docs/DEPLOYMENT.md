# Production deployment guide

This guide describes a conventional self-hosted Linux deployment using PM2 or systemd, Nginx as a TLS reverse proxy, and Oracle 26ai. Adapt it to your infrastructure and threat model.

## Reference architecture

```text
Internet
   |
Nginx (TLS + trusted proxy headers)
   |
CodeAtlas Platform (Express :3381, SSE)
   |
Oracle 26ai + Firebase + NVIDIA NIM
```

For container orchestration, prefer one Uvicorn/Node process per container and scale at the container level.

## Prerequisites

- Linux server (Ubuntu 22.04+ recommended)
- Node.js 20+
- pnpm 9+
- Oracle 26ai (Autonomous Database or self-hosted)
- Domain with TLS certificate (Let's Encrypt or commercial CA)
- Firebase service account JSON
- NVIDIA NIM API key

## Build the server

```bash
git clone https://github.com/giauphan/codeatlas-platform.git
cd codeatlas-platform
cp .env.example .env
# Edit .env with production credentials
pnpm install --frozen-lockfile --prod
pnpm run build
pnpm run db-init
```

Verify the build:

```bash
node dist/src/index.js --version 2>/dev/null || echo "Server starts on PORT or stdio"
```

## Option 1: PM2

Install PM2 globally:

```bash
npm install -g pm2
```

Create `ecosystem.config.js` at the project root:

```javascript
module.exports = {
  apps: [{
    name: 'codeatlas-platform',
    script: 'dist/src/index.js',
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '4G',
    env: {
      PORT: 3381,
      NODE_ENV: 'production'
    }
  }]
};
```

Start the server:

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # follow the printed instructions to enable boot
```

## Option 2: systemd

Create `/etc/systemd/system/codeatlas.service`:

```ini
[Unit]
Description=CodeAtlas Platform
After=network.target

[Service]
Type=simple
User=codeatlas
WorkingDirectory=/opt/codeatlas-platform
EnvironmentFile=/opt/codeatlas-platform/.env
ExecStart=/usr/bin/node dist/src/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable codeatlas
sudo systemctl start codeatlas
sudo systemctl status codeatlas
sudo journalctl -u codeatlas -f
```

## Nginx reverse proxy with TLS

Install Nginx and Certbot:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/codeatlas.conf`:

```nginx
server {
    listen 80;
    server_name codeatlas.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name codeatlas.example.com;

    ssl_certificate /etc/letsencrypt/live/codeatlas.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/codeatlas.example.com/privkey.pem;

    # SSE requires buffering disabled
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;

    location / {
        proxy_pass http://127.0.0.1:3381;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection '';
    }
}
```

Enable and obtain TLS certificate:

```bash
sudo ln -s /etc/nginx/sites-available/codeatlas.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d codeatlas.example.com
```

## Health check

The server exposes `GET /health` for liveness probes:

```bash
curl http://localhost:3381/health
```

Use this in PM2 or systemd health checks, and in load balancer liveness probes.

## Multi-tenant deployment

For multi-tenant deployments:

1. Set `CODEATLAS_MULTI_TENANT=true` in `.env`.
2. Configure `CODEATLAS_PROJECTS_ROOT` to a writable directory for tenant sandboxes.
3. Set `GOOGLE_APPLICATION_CREDENTIALS` to a Firebase service account with Firestore access.
4. Restrict `ALLOWED_ORIGINS` to your dashboard origin only.
5. Set `CODEATLAS_API_KEY` to a strong secret, or rely on Firebase Bearer tokens.

## Dashboard deployment

The dashboard is a separate Vite app in `dashboard/`:

```bash
cd dashboard
pnpm install
pnpm run build
# Serve dist/ via Nginx, Vercel, Netlify, or any static host
```

Set `VITE_FIREBASE_*` env vars before build. The dashboard calls the platform API at the origin configured in `App.tsx` (defaults to `http://localhost:8080` in dev — override for production).

## Database migrations

Run `pnpm run db-init` before starting the server after any schema change. The script is idempotent and safe to run on every deploy:

```bash
pnpm run db-init
```

## Logging

Logs are written to stdout/stderr. PM2 captures them in `~/.pm2/logs/`. systemd writes to journald.

```bash
# PM2
pm2 logs codeatlas-platform

# systemd
sudo journalctl -u codeatlas -f
```

## Rollback

To rollback a deployment:

1. `git checkout <previous-tag>` in the project directory.
2. `pnpm install --frozen-lockfile`.
3. `pnpm run build`.
4. `pm2 restart codeatlas-platform` (or `sudo systemctl restart codeatlas`).

Database migrations are backward-compatible (nullable columns), so rollback does not require schema changes.
