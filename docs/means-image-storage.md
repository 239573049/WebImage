# Means 图片存储配置

`/v1/images/generations` 和 `/v1/images/edits` 支持 OpenAI 风格的
`response_format`：

- `b64_json`：只返回 `b64_json`，不会上传到 Means。
- `url`：当 `means.enabled` 为 `true` 时，将图片上传到 Means，并只返回
  不含查询参数的对象 URL。

先在 Means 中创建用于保存图片的 bucket，然后将以下配置加入项目根目录
`config.json`：

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

`endpoint` 是 chatgpt2api 服务端访问 Means S3 数据面的地址。若外部访问地址
不同，可设置 `public_base_url`；它应当包含 bucket 路径。留空时直接返回
`{endpoint}/{bucket}/{key}`。返回前会移除 URL 的 query 和 fragment，因此
bucket 或 CDN 必须允许用户通过该普通 URL 读取对象。

请求示例：

```bash
curl http://127.0.0.1:8000/v1/images/generations \
  -H "Authorization: Bearer YOUR_CHATGPT2API_KEY" \
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

响应中的 `url` 不包含 `?X-Amz-*` 等签名参数。
