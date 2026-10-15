# 部署与升级指南

本文介绍 ChatGPT2API 的常见部署方式，以及后续升级项目时需要保留的数据和执行步骤。

## 部署前准备

服务器需要安装：

- Docker
- Docker Compose v2
- Git

首次部署前建议确认：

```bash
docker version
docker compose version
git --version
```

项目核心持久化文件：

| 路径 | 作用 |
| --- | --- |
| `config.json` | 主配置、后台密钥、代理、图片、备份等配置 |
| `.env` | Docker compose 环境变量 |
| `data/` | 账号、日志、图片、任务记录等运行数据 |

升级和迁移时重点保留以上内容。

## 方式一：Docker Compose 部署（推荐）

仓库根目录的 `docker-compose.yml` 会启动两个容器：

- `app`：主服务（对外 `3000`）
- `sentinel-solver`：自带 Chromium 的 turnstile 求解服务（仅内网 `8788`）

网页端 turnstile 挑战需要真实 Chromium，缺了 `sentinel-solver` 网页生图链路不可用，所以它是默认部署的一部分。

```bash
git clone https://github.com/239573049/WebImage.git
cd chatgpt2api
cp .env.example .env
```

至少修改 `.env` 中的两个值：

```text
CHATGPT2API_AUTH_KEY=your_secret_key_here
SENTINEL_SOLVER_KEY=change_me_to_a_long_random_string
```

启动：

```bash
docker compose up -d --build
```

需要图片返回直链时，可以另外部署 Means 对象存储（见 [Means 图片存储配置](./means-image-storage.md)），并把 `CHATGPT2API_MEANS_*` 指向它。

访问：

```text
http://localhost:3000
```

API 基础地址：

```text
http://localhost:3000/v1
```

上游请求经常被 Cloudflare 拦截时，把稳定代理运行时的出口指向宿主机上的 WARP / Privoxy / 其他 HTTP 代理：

```text
CHATGPT2API_PROXY_RUNTIME_ENABLED=true
CHATGPT2API_PROXY_RUNTIME_PROXY_URL=http://host.docker.internal:40080
```

代理运行时配置也可以在后台设置页的「稳定代理运行时」面板中查看、保存和测试。

查看容器状态：

```bash
docker compose ps
```

查看日志：

```bash
docker logs -f chatgpt2api
docker logs -f chatgpt2api-solver
```

停止：

```bash
docker compose down
```

## 方式二：源码运行

适合本地开发或临时调试。

后端：

```bash
git clone https://github.com/239573049/WebImage.git
cd chatgpt2api
uv sync
uv run main.py
```

前端开发服务：

```bash
cd web
bun install
bun run dev
```

源码方式运行时，后端默认读取项目根目录的 `config.json` 和 `data/`。

## 存储后端

默认使用本地 SQLite 数据库：

```text
STORAGE_BACKEND=sqlite
```

可选值：

| 值 | 说明 |
| --- | --- |
| `sqlite` | 本地 SQLite，默认方式，存放在 `data/accounts.db` |
| `json` | 本地 JSON 文件 |
| `postgres` | 外部 PostgreSQL |
| `git` | Git 私有仓库存储账号数据 |

首次以 SQLite 启动时，如检测到旧的 `data/accounts.json` / `data/auth_keys.json` 且数据库为空，会自动迁移数据并将旧文件重命名为 `*.json.migrated` 备份。

PostgreSQL 示例：

```yaml
environment:
  - STORAGE_BACKEND=postgres
  - DATABASE_URL=postgresql://user:password@host:5432/dbname
```

SQLite 示例：

```yaml
environment:
  - STORAGE_BACKEND=sqlite
  - DATABASE_URL=sqlite:////app/data/accounts.db
```

## 升级前备份

升级前建议备份：

```bash
mkdir -p backups
tar -czf backups/chatgpt2api-$(date +%Y%m%d-%H%M%S).tgz config.json .env data
```

如果没有 `.env`，可以去掉：

```bash
tar -czf backups/chatgpt2api-$(date +%Y%m%d-%H%M%S).tgz config.json data
```

也可以在后台设置页配置 Cloudflare R2 备份，用于定时备份关键数据。

## 升级：Docker Compose 部署

进入项目目录：

```bash
cd chatgpt2api
```

备份：

```bash
mkdir -p backups
tar -czf backups/chatgpt2api-$(date +%Y%m%d-%H%M%S).tgz config.json .env data
```

拉取最新代码并重新构建（`docker compose pull` 只更新镜像，本仓库的 `app` 与 `sentinel-solver` 都带 `build:`，所以仍建议带 `--build`）：

```bash
git pull
docker compose pull
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
docker logs -f chatgpt2api
```

## 升级：源码运行

```bash
cd chatgpt2api
git pull
uv sync
```

如果需要重新构建前端静态产物：

```bash
cd web
bun install
bun run build
```

然后按你的进程管理方式重启后端服务。

## 回滚

如果升级后需要回滚代码：

```bash
git log --oneline -n 20
git checkout <旧版本commit>
```

Docker Compose 部署：

```bash
docker compose up -d
```

如果需要恢复数据：

```bash
tar -xzf backups/你的备份文件.tgz
```

恢复数据前建议先停止容器，避免运行中写入覆盖：

```bash
docker compose down
```

## 常用维护命令

查看容器：

```bash
docker compose ps
```

查看主服务日志与求解服务日志：

```bash
docker logs -f chatgpt2api
docker logs -f chatgpt2api-solver
```

重启：

```bash
docker compose restart
```

清理未使用镜像：

```bash
docker image prune
```

不要直接删除 `data/`、`config.json`、`.env`，除非已经确认有可用备份。
