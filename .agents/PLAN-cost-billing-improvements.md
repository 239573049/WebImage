# ChatGPT2API 计费/成本改进计划

> 分析范围：token 消耗统计、配额控制、成本核算、缓存省钱。基于当前代码（2025 版）。

## 一、现状分析（证据）

### 1. Token 统计：本地估算、不持久化、无聚合

- `utils/image_tokens.py:295 token_usage()`：`cached_tokens` 与 `reasoning_tokens` 恒为 0（硬编码），
  不反映上游真实缓存/思考 token。
- `utils/image_tokens.py:183 count_image_input_tokens()`：**忽略传入的 `model` 参数**，
  所有模型一律用 `IMAGE_INPUT_TOKEN_MODEL = "gpt-5.4-mini"`（12 行）计算 patch token。
  o4-mini / gpt-5.2 等不同价模型会算错。
- `utils/image_tokens.py:290 compensate_image_generation_output_tokens()`：硬编码 "+350" 补偿，
  无注释说明依据，价格口径变更时易失真。
- `services/protocol/conversation.py:305-330` 与 `openai_v1_chat_complete.py:86-110`：
  文本链路 usage 全部本地估算（`count_message_text_tokens` / `count_text_tokens`），
  **不从上游 SSE 提取真实 usage**。
- 任何 usage 数据**只出现在响应里，不落盘**：无法按天/账号/调用方/模型聚合，
  没有成本报表。

### 2. 配额控制：图片有、文本没有

- 图片链路已有完整控制：`services/account_service.py:1038-1069` 按套餐并发槽位分配，
  全忙抛 `ImageQuotaBusyError` → 429；`openai_backend_api.py:293` 从上游
  `limits_progress` 提取 `image_gen` 剩余额度并回写账号 `quota`。
- **chat 文本链路无任何配额/限流**：单账号可以被无限调用，封号即成本损失
  （账号是核心资产）。
- `auto_remove_rate_limited_accounts`（config.py:624）默认关闭。
- 调用方维度：`api/support.py:30 require_identity()` 只有一个全局 auth-key，
  **没有多 key / 按 key 限额**，无法区分调用方做预算控制。

### 3. 指标：无 token/成本维度

- `services/metrics_service.py`：只有请求数、成功/失败、耗时、rpm，
  无 token、无成本、无缓存命中。进程内存，重启清零。

### 4. 缓存（已有省钱能力，但不可见）

- `services/protocol/chat_completion_cache.py`：TTL、in-flight 去重、流式缓存、
  消息归一化齐全（不错的底子）。
- **缓存命中/未命中没有统计**，省了多少 token/钱完全不可见。
- 图片上传缓存 TTL 存在（config.py:566），同样无命中统计。

### 5. 日志

- `services/log_service.py`：请求日志有，但无聚合 token/成本报表，无法回答
  "昨天每个账号花了多少"。

---

## 二、改进计划（按优先级）

### P0 — 数据基础：usage 持久化 + 缓存命中统计

**1. 新增 UsageRecorder（usage 落盘与聚合）**
- 新建 `services/usage_service.py`：线程安全、追加写 JSONL（`DATA_DIR/usage/*.jsonl`，
  按天分文件），单条记录含：时间、endpoint、model、input/output tokens、
  cached/reasoning tokens、账号 access_token 指纹（sha256 前 8 位）、api key 指纹、
  耗时、缓存命中标志。
- 在 `services/protocol/openai_v1_chat_complete.py`、`openai_v1_response.py`、
  `openai_v1_image_generations.py` 等所有构造 usage 的位置调用记录器（一处 helper，
  避免散落）。
- 提供只读聚合 API（`api/system.py`）：`/api/metrics/usage?days=7` 返回按
  天/模型/账号/端点的 token 聚合与请求数。

**2. 缓存命中统计**
- `ChatCompletionCache` 增加原子 `hits` / `misses` 计数与查询方法。
- 命中时把"应省 tokens"记入 usage 记录（用请求侧估算的 input+output tokens），
  metrics 接口展示命中率与估算节省。

**验收**：调几个 chat/图片接口后，`/api/metrics/usage` 能看到聚合数据；
两次相同请求第二次命中缓存且记录 cache_hit=1。

### P1 — 成本控制：chat 配额 + 调用方限额 + 成本面板

**3. chat 链路账号级限流（防封号）**
- 参考图片槽位机制（account_service.py:1038 附近），为文本链路加：
  - 每账号最大并发数（复用现有 slot 分配思路）；
  - 每账号每日请求上限（config 可配，默认关）。
- 超限抛统一异常，`services/protocol/error_response.py` 转 429。

**4. 多 API key + 每 key 预算**
- `services/config.py` 增加 `api_keys` 列表（每 key：名称、token 预算/日、请求上限/日，
  可选到期时间）；`api/support.py require_identity()` 兼容多 key，
  单 key 旧配置继续可用。
- `usage_service.py` 聚合结果与预算比对，超限 429；`/api/metrics/usage` 增加
  按 key 维度。

**5. 成本估算与面板数据接口**
- `services/model_service.py` 或 config 增加模型单价表（每 1k tokens 美元，
  input/output/cached 分别定价），用于估算。
- `/api/metrics/cost` 返回按账号/模型/天的估算成本 + 缓存节省估算。
- 账号订阅档（plus/pro）已在 `openai_backend_api.py:328-346` 获取，可作为
  每账号"固定成本"展示，算出账号 ROI（消耗额 / 订阅费）。

**验收**：配置某 key 日预算为 0 时该 key 被 429；成本接口数值与单价表一致。

### P2 — 估算准确性

**6. 修 image token 估算 bug**
- `count_image_input_tokens()` 真正使用传入 `model`（去掉硬编码
  `IMAGE_INPUT_TOKEN_MODEL`，保留作为未知模型的回退）。
- 给 `compensate_image_generation_output_tokens()` 的 350 补偿加来源注释，
  并下沉为 config 常量（口径变更时可调）。

**7. 优先采用上游真实 usage**
- 文本 SSE 响应若携带 usage 字段则优先采用；否则回退本地估算。
  估算/真实来源标记进 usage 记录。

**8. cached/reasoning tokens 真实值**
- 上游返回缓存/思考 token 时写入 `token_usage()` 对应字段，替代恒 0。

### P3 — 运营增强（可选，视需要）

**9. 封号预警**
- 账号连续失败/限流阈值触发日志告警（复用 log_service），可扩展 Webhook 通知。

**10. 指标进程内维度补充**
- `AiMetricsService` 增加 token 累计维度（sum/分桶），与 usage 持久化互补。

---

## 三、明确不做（本次）

- 不引入真正的计费/支付系统（项目定位为自托管工具，超出范围）。
- 不改图片槽位分配核心逻辑（已有测试覆盖：test/test_image_slot_allocation.py）。
- 不迁移存储后端（json/git/database 三套并存现状不动）。

## 四、风险

- usage 落盘量：高频调用下 JSONL 增长需按天滚动 + 保留天数配置。
- 多 key 改动涉及鉴权面（api/support.py），需保持旧单 key 行为不变并补测试。
- 单价表是估算，展示层必须标注"估算值"。
