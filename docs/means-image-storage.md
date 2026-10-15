# Means 图片存储配置

[Means](https://github.com/AIDotNet/Means)（MIT）是一个可自部署的 S3 兼容对象存储，用 ASP.NET Core 实现，自带管理控制台。让 WebImage 把生成的图片上传到 Means 后，`response_format=url` 返回的就是自己对象存储上的直链，不再依赖本机文件目录和 `base_url`。

本文顺序：部署 Means → 建 bucket → 在 WebImage 中配置 → 调用示例 → 排查。

## 一、部署 Means

方式一（推荐）：单独部署 Means，和已有的 WebImage 对接。把 WebImage 的 `CHATGPT2API_MEANS_ENDPOINT` 指向 Means 的宿主机地址（如 `http://127.0.0.1:5178/s3/`）。

方式二：Means 和 WebImage 放在同一个 compose 里，把下面这段 `means` 服务加到仓库根目录的 [`docker-compose.yml`](../docker-compose.yml) 里，此时两者用服务名 `means:8080` 互通，endpoint 写 `http://means:8080/s3/`。

下面这个 `docker-compose.yml` 是方式一的写法，新建一个目录放进去即可：

```yaml
services:
  means:
    image: hejiale010426/means
    container_name: means
    restart: unless-stopped
    user: "0:0"
    ports:
      - "5178:8080"
    environment:
      ASPNETCORE_URLS: "http://+:8080"
      AllowedHosts: "*"
      # 控制台账号
      Means__Console__AdminUser: "meansadmin"
      Means__Console__AdminPassword: "换成你自己的控制台密码"
      # S3 数据面密钥（WebImage 用的就是这一对）
      Means__Storage__DefaultAccessKey: "meansadmin"
      Means__Storage__DefaultSecretKey: "换成你自己的密钥"
      # 数据盘
      Means__Storage__ObjectsPath: "/data/objects"
      Means__Storage__Disks__0: "/data/xlfs/disk1"
      Means__Storage__Disks__1: "/data/xlfs/disk2"
      Means__Storage__Disks__2: "/data/xlfs/disk3"
      Means__Storage__Disks__3: "/data/xlfs/disk4"
      Means__S3__AliasPrefix: "/s3"
    volumes:
      - means-objects:/data/objects
      - means-xlfs-disk1:/data/xlfs/disk1
      - means-xlfs-disk2:/data/xlfs/disk2
      - means-xlfs-disk3:/data/xlfs/disk3
      - means-xlfs-disk4:/data/xlfs/disk4

volumes:
  means-objects:
  means-xlfs-disk1:
  means-xlfs-disk2:
  means-xlfs-disk3:
  means-xlfs-disk4:
```

```bash
docker compose up -d
docker logs -f means
```

说明：

- 上面的镜像名是官方预构建镜像（只有 `latest` 一个 tag）。想跟着源码构建，就克隆 [AIDotNet/Means](https://github.com/AIDotNet/Means) 后执行 `docker compose up -d --build`，官方 compose 里默认就是构建 tag 为 `hejiale010426/means` 的镜像。
- 控制台默认账号是 `meansadmin` / `meansadmin-local`，S3 默认密钥是 `meansadmin` / `meansadmin-local-secret`。**Means 检测到默认凭据时会拒绝以生产模式启动**，所以部署前务必换成自己的值；环境变量名分别是 `Means__Console__AdminUser`、`Means__Console__AdminPassword`、`Means__Storage__DefaultAccessKey`、`Means__Storage__DefaultSecretKey`。
- 宿主端口默认 `5178`，容器内是 `8080`。从 WebImage 容器访问填容器内地址 `http://means:8080/s3/`，从宿主机上的客户端访问才是 `http://127.0.0.1:5178/s3/`。
- 上面挂的 5 个 volume 就是全部图片数据，删掉等于删数据。

## 二、建 bucket

打开 `http://127.0.0.1:5178` 用控制台账号登录，在 Buckets 里新建一个 bucket，例如 `generated-images`。

Means 支持 path-style 和 virtual-hosted-style 两种寻址。同源别名是 path-style：

```text
http://localhost:5178/s3/{bucket}/{key}
```

WebImage 用的是 path-style，所以 `endpoint` 写成 `http://127.0.0.1:5178/s3/`（结尾带不带 `/` 都可以，服务端会去掉尾部斜杠）。

## 三、在 WebImage 中配置

### 写入 `config.json`

把下面这段加到项目根目录的 `config.json`（`enabled` 为 `true` 时，`endpoint`、`access_key`、`secret_key`、`bucket` 四项都必须填，否则启动会报配置错误）：

```json
{
  "means": {
    "enabled": true,
    "endpoint": "http://127.0.0.1:5178/s3/",
    "access_key": "meansadmin",
    "secret_key": "replace-with-your-means-secret",
    "bucket": "generated-images",
    "prefix": "chatgpt2api/images",
    "public_base_url": "https://files.example.com/generated-images",
    "region": "us-east-1",
    "service": "s3",
    "timeout_seconds": 60,
    "verify_ssl": true
  }
}
```

完整可复制版本见 [config.example.json](../config.example.json)。改完 `config.json` 需要重启服务。

### 用环境变量初始化

Docker 部署时也可以只给环境变量，首次启动会写入 `config.json`：

```yaml
environment:
  - CHATGPT2API_MEANS_ENABLED=true
  - CHATGPT2API_MEANS_ENDPOINT=http://means:8080/s3/
  - CHATGPT2API_MEANS_ACCESS_KEY=meansadmin
  - CHATGPT2API_MEANS_SECRET_KEY=your_means_secret
  - CHATGPT2API_MEANS_BUCKET=generated-images
  - CHATGPT2API_MEANS_PREFIX=chatgpt2api/images
  - CHATGPT2API_MEANS_PUBLIC_BASE_URL=https://files.example.com/generated-images
```

注意：**环境变量只在 `config.json` 里还没有 `means` 字段时生效**。一旦写过一次，之后就以 `config.json` 为准，再改环境变量不会覆盖它。

用容器跑 WebImage 时，`endpoint` 要按「WebImage 容器能不能访问到 Means」来填，而不是浏览器能不能访问：

| 部署方式 | `endpoint` |
| --- | --- |
| 都在同一个 compose（把 `means` 服务加进仓库的 `docker-compose.yml`） | `http://means:8080/s3/`，容器内端口是 8080 |
| Means 在宿主机（源码或单容器） | `http://host.docker.internal:5178/s3/`，注意不是 `127.0.0.1` |
| WebImage 跑在宿主机源码模式 | `http://127.0.0.1:5178/s3/` |
| Means 在另一台机器 | `http://<means 的地址>:5178/s3/` |

### 字段说明

| 字段 | 说明 |
| --- | --- |
| `enabled` | 总开关。为 `true` 时图片走 Means，为 `false` 时走本地图片存储 |
| `endpoint` | 服务端访问 Means S3 数据面的地址，path-style，例如 `http://127.0.0.1:5178/s3/`。WebImage 和 Means 都在 Docker 时写容器内地址 `http://means:8080/s3/`，详见下节 |
| `access_key` | Means 的 S3 Access Key |
| `secret_key` | Means 的 S3 Secret Key |
| `bucket` | 保存图片的 bucket，需要先在 Means 中创建 |
| `prefix` | 对象 key 前缀，默认 `chatgpt2api/images` |
| `public_base_url` | 返回给客户端的地址前缀，**需要包含 bucket 路径**（如 `https://files.example.com/generated-images`）。留空则直接返回 `{endpoint}/{bucket}/{key}` |
| `region` | SigV4 签名区域，默认 `us-east-1` |
| `service` | SigV4 签名服务名，默认 `s3` |
| `timeout_seconds` | 上传超时，默认 60 秒 |
| `verify_ssl` | 上传时是否校验 TLS 证书，默认 `true`。`endpoint` 是自签名 HTTPS 时可设为 `false` |

对象 key 的格式是 `{prefix}/{年}/{月}/{日}/{图片SHA256}.png`，同一张图片重复上传会覆盖成同一个对象。上传用 SigV4 签名（`UNSIGNED-PAYLOAD`）的 `PUT`，任何支持 path-style 的 S3 客户端都能读同一批文件。

### 代理

上传请求遵循设置页里的全局代理；和本地服务一样，`endpoint` 指向 `127.0.0.1` / `localhost` / `::1` 时保持直连。Means 跑在另一个容器里时，`endpoint` 用容器名（例如 `http://means:8080/s3/`）或宿主机地址，不要写 `127.0.0.1`。

## 四、调用示例

`response_format` 的取值：

- `b64_json`：只返回 `b64_json`，不会上传到 Means。
- `url`：`means.enabled` 为 `true` 时上传到 Means，只返回不含查询参数的对象 URL。

```bash
curl http://127.0.0.1:8000/v1/images/generations \
  -H "Authorization: Bearer YOUR_AUTH_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "一只坐在窗边的橘猫",
    "response_format": "url"
  }'
```

响应示例：

```json
{
  "created": 1785312000,
  "data": [
    {
      "url": "https://files.example.com/generated-images/chatgpt2api/images/2026/07/29/IMAGE_SHA256.png",
      "revised_prompt": "一只坐在窗边的橘猫"
    }
  ]
}
```

`response_format=url` 时返回的 `url` 不包含 `?X-Amz-*` 等签名参数，所以 bucket 或前面的 CDN 必须允许用户通过这个普通 URL 直接读取对象。

## 五、排查

| 现象 | 原因 |
| --- | --- |
| 启动报「启用 Means 图片存储后必须填写：…」 | `enabled=true` 但 `endpoint` / `access_key` / `secret_key` / `bucket` 有空值 |
| 返回的 URL 打开 403 / 404 | bucket 未允许公开读取；或 `public_base_url` 少了 bucket 路径；或对象 key 写错 |
| `Means 图片上传失败，HTTP 403` | `access_key` / `secret_key` 不对，签名被拒 |
| `Means 图片上传失败，HTTP 404` | `bucket` 拼错或还没在 Means 里创建 |
| `Means 图片上传失败：连接错误` | `endpoint` 不可达；容器里写了 `127.0.0.1`；或宿主端口映射不是 5178 |
| 改了环境变量没生效 | `config.json` 里已经有 `means` 字段，改 `config.json` 才有效 |
| 图片还是存在本地 | `enabled` 为 `false`，或用了 `response_format=b64_json` |
