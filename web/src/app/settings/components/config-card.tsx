"use client";

import { Cloud, LoaderCircle, PlugZap, RefreshCw, Save } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { ImageStorageMode } from "@/lib/api";
import { testProxy, type ProxyTestResult } from "@/lib/api";

import { useSettingsStore } from "../store";

// 键名须与后端 AccountService._normalize_account_type 的归一化输出一致
const PLAN_CONCURRENCY_FIELDS = [
  { key: "free", label: "Free", fallback: 1 },
  { key: "Plus", label: "Plus", fallback: 2 },
  { key: "Team", label: "Team", fallback: 2 },
  { key: "K12", label: "K12", fallback: 2 },
  { key: "Pro", label: "Pro", fallback: 5 },
  { key: "ProLite", label: "Pro Lite", fallback: 2 },
  { key: "Enterprise", label: "Enterprise", fallback: 5 },
] as const;

export function ConfigCard() {
  const [isTestingProxy, setIsTestingProxy] = useState(false);
  const [proxyTestResult, setProxyTestResult] = useState<ProxyTestResult | null>(null);
  const logLevelOptions = ["debug", "info", "warning", "error"];
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const setRefreshAccountIntervalMinute = useSettingsStore((state) => state.setRefreshAccountIntervalMinute);
  const setImageRetentionDays = useSettingsStore((state) => state.setImageRetentionDays);
  const setImagePollTimeoutSecs = useSettingsStore((state) => state.setImagePollTimeoutSecs);
  const setImagePlanConcurrency = useSettingsStore((state) => state.setImagePlanConcurrency);
  const setImageSettleEnabled = useSettingsStore((state) => state.setImageSettleEnabled);
  const setImageRemoveConversationAfterResult = useSettingsStore((state) => state.setImageRemoveConversationAfterResult);
  const setImageRemoveConversationAlways = useSettingsStore((state) => state.setImageRemoveConversationAlways);
  const setImageSettleSecs = useSettingsStore((state) => state.setImageSettleSecs);
  const setImageTimeoutRetrySecs = useSettingsStore((state) => state.setImageTimeoutRetrySecs);
  const setAutoRemoveInvalidAccounts = useSettingsStore((state) => state.setAutoRemoveInvalidAccounts);
  const setAutoRemoveRateLimitedAccounts = useSettingsStore((state) => state.setAutoRemoveRateLimitedAccounts);
  const setAutoReloginAfterRefresh = useSettingsStore((state) => state.setAutoReloginAfterRefresh);
  const setLogLevel = useSettingsStore((state) => state.setLogLevel);
  const setProxy = useSettingsStore((state) => state.setProxy);
  const setBaseUrl = useSettingsStore((state) => state.setBaseUrl);
  const setGlobalSystemPrompt = useSettingsStore((state) => state.setGlobalSystemPrompt);
  const setDefaultUpstreamModelName = useSettingsStore((state) => state.setDefaultUpstreamModelName);
  const setDefaultThinkingEffort = useSettingsStore((state) => state.setDefaultThinkingEffort);
  const setCustomImageModelsText = useSettingsStore((state) => state.setCustomImageModelsText);
  const setDefaultImageModel = useSettingsStore((state) => state.setDefaultImageModel);
  const setSensitiveWordsText = useSettingsStore((state) => state.setSensitiveWordsText);
  const setAIReviewField = useSettingsStore((state) => state.setAIReviewField);
  const setImageStorageField = useSettingsStore((state) => state.setImageStorageField);
  const testImageStorage = useSettingsStore((state) => state.testImageStorage);
  const syncImagesToWebDAV = useSettingsStore((state) => state.syncImagesToWebDAV);
  const isTestingImageStorage = useSettingsStore((state) => state.isTestingImageStorage);
  const isSyncingImageStorage = useSettingsStore((state) => state.isSyncingImageStorage);
  const saveConfig = useSettingsStore((state) => state.saveConfig);

  const handleTestProxy = async () => {
    const candidate = String(config?.proxy || "").trim();
    if (!candidate) {
      toast.error("请先填写代理地址");
      return;
    }
    setIsTestingProxy(true);
    setProxyTestResult(null);
    try {
      const data = await testProxy(candidate);
      setProxyTestResult(data.result);
      if (data.result.ok) {
        toast.success(`代理可用（${data.result.latency_ms} ms，HTTP ${data.result.status}）`);
      } else {
        toast.error(`代理不可用：${data.result.error ?? "未知错误"}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "测试代理失败");
    } finally {
      setIsTestingProxy(false);
    }
  };

  if (isLoadingConfig) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center p-10">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <div className="rounded-xl border border-border bg-field/50 px-4 py-3 text-sm leading-6 text-foreground/80">
          管理员登录密钥继续从部署配置读取，不再在此页面展示；如需分发给其他人，请在下方创建普通用户密钥。
        </div>

        <div className="space-y-5 border-t border-border pt-5">
          <h3 className="text-[15px] font-semibold tracking-tight">刷新与代理</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">账号刷新间隔</label>
              <Input
                value={String(config?.refresh_account_interval_minute || "")}
                onChange={(event) => setRefreshAccountIntervalMinute(event.target.value)}
                placeholder="分钟"
              />
              <p className="text-xs leading-5 text-muted-foreground">单位分钟，控制账号自动刷新频率。</p>
            </div>
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">全局代理</label>
              <Input
                value={String(config?.proxy || "")}
                onChange={(event) => {
                  setProxy(event.target.value);
                  setProxyTestResult(null);
                }}
                placeholder="http://127.0.0.1:7890"
              />
              <p className="text-xs leading-5 text-muted-foreground">
                留空表示不使用代理。支持协议://账号:密码@主机:端口，也可直接粘贴代理商的 主机:端口:账号:密码；示例 http://user:pass@127.0.0.1:7890、127.0.0.1:7890:user:pass。账号密码含 @/: 等特殊字符时需 URL 编码。
              </p>
              {proxyTestResult ? (
                <div
                  className={`rounded-xl px-3 py-2 text-xs leading-6 ${
                    proxyTestResult.ok
                      ? "bg-success/10 text-success"
                      : "bg-destructive/10 text-destructive"
                  }`}
                >
                  {proxyTestResult.ok
                    ? `代理可用：HTTP ${proxyTestResult.status}，用时 ${proxyTestResult.latency_ms} ms`
                    : `代理不可用：${proxyTestResult.error ?? "未知错误"}（用时 ${proxyTestResult.latency_ms} ms）`}
                </div>
              ) : null}
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleTestProxy()}
                  disabled={isTestingProxy}
                >
                  {isTestingProxy ? <LoaderCircle className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                  测试代理
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-5 border-t border-border pt-5">
          <h3 className="text-[15px] font-semibold tracking-tight">上游与模型</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">图片访问地址</label>
              <Input
                value={String(config?.base_url || "")}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://example.com"
              />
              <p className="text-xs leading-5 text-muted-foreground">用于生成图片结果的访问前缀地址。</p>
            </div>
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">默认请求上游模型名称</label>
              <Input
                value={String(config?.default_upstream_model_name || "")}
                onChange={(event) => setDefaultUpstreamModelName(event.target.value)}
                placeholder="gpt-6"
              />
              <p className="text-xs leading-5 text-muted-foreground">gpt-image-2 发起图片请求时使用的上游模型名称，默认 gpt-6。</p>
            </div>
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">默认思考强度</label>
              <Select
                value={String(config?.default_thinking_effort || "auto")}
                onValueChange={(value) => setDefaultThinkingEffort(value as "auto" | "standard" | "extended" | "max")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto（不传递）</SelectItem>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="extended">Extended</SelectItem>
                  <SelectItem value="max">Max</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs leading-5 text-muted-foreground">模型名称以 -standard、-extended 或 -max 结尾时，模型后缀优先。</p>
            </div>
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">默认生图模型</label>
              <Select
                value={String(config?.default_image_model || "")}
                onValueChange={setDefaultImageModel}
              >
                <SelectTrigger>
                  <SelectValue placeholder="gpt-image-2" />
                </SelectTrigger>
                <SelectContent>
                  {(config?.image_models || []).map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs leading-5 text-muted-foreground">请求未指定 model 时使用的生图模型。</p>
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-[13px] font-medium text-foreground/80">自定义生图模型</label>
              <Textarea
                value={(config?.custom_image_models || []).join("\n")}
                onChange={(event) => setCustomImageModelsText(event.target.value)}
                placeholder="一行一个上游模型名，例如 gpt-image-2.5-sunburst"
                className="min-h-24 font-mono text-xs"
              />
              <p className="text-xs leading-5 text-muted-foreground">
                在官网画图链路可用的上游模型基础上补充型号，模型名会原样透传给上游；内置型号无需重复填写。
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-5 border-t border-border pt-5">
          <h3 className="text-[15px] font-semibold tracking-tight">生图与并发</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">图片自动清理</label>
              <Input
                value={String(config?.image_retention_days || "")}
                onChange={(event) => setImageRetentionDays(event.target.value)}
                placeholder="30"
              />
              <p className="text-xs leading-5 text-muted-foreground">自动删除多少天前的本地图片。</p>
            </div>
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">图片轮询超时</label>
              <Input
                value={String(config?.image_poll_timeout_secs || "")}
                onChange={(event) => setImagePollTimeoutSecs(event.target.value)}
                placeholder="120"
              />
              <p className="text-xs leading-5 text-muted-foreground">单位秒，等待上游图片结果的最长时间。</p>
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-[13px] font-medium text-foreground/80">单账号图片并发（按套餐）</label>
              <div className="grid grid-cols-2 gap-3 rounded-2xl border border-border bg-field/50 p-4 sm:grid-cols-4">
                {PLAN_CONCURRENCY_FIELDS.map((plan) => (
                  <div key={plan.key} className="space-y-1">
                    <span className="text-xs text-muted-foreground">{plan.label}</span>
                    <Input
                      value={String(config?.image_plan_concurrency?.[plan.key] ?? "")}
                      onChange={(event) => setImagePlanConcurrency(plan.key, event.target.value)}
                      placeholder={String(plan.fallback)}
                    />
                  </div>
                ))}
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                每个账号按其套餐限制同时处理的图片请求数；账号被分配后直到该请求结算才释放。
                所有账号都占满时新请求直接返回 429。
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-5 border-t border-border pt-5">
          <h3 className="text-[15px] font-semibold tracking-tight">生图对话与账号清理</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-field/50 px-4 py-3">
              <div className="space-y-0.5">
                <div className="text-[13px] font-medium text-foreground/80">自动移除异常账号</div>
                <div className="text-xs leading-5 text-muted-foreground">刷新时检测并移除</div>
              </div>
              <Switch
                checked={Boolean(config?.auto_remove_invalid_accounts)}
                onCheckedChange={(checked) => setAutoRemoveInvalidAccounts(Boolean(checked))}
              />
            </label>
            <label className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-field/50 px-4 py-3">
              <div className="space-y-0.5">
                <div className="text-[13px] font-medium text-foreground/80">图片二次确认机制</div>
                <div className="text-xs leading-5 text-muted-foreground">打开后能稍微提升获取图片的成功率。</div>
              </div>
              <Switch
                checked={Boolean(config?.image_settle_enabled !== false)}
                onCheckedChange={(checked) => setImageSettleEnabled(Boolean(checked))}
              />
            </label>
            <label className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-field/50 px-4 py-3">
              <div className="space-y-0.5">
                <div className="text-[13px] font-medium text-foreground/80">出图后移除本地对话</div>
                <div className="text-xs leading-5 text-muted-foreground">成功拿到图片后，异步隐藏 ChatGPT 侧对应的本地对话记录。</div>
              </div>
              <Switch
                checked={Boolean(config?.image_remove_conversation_after_result)}
                onCheckedChange={(checked) => setImageRemoveConversationAfterResult(Boolean(checked))}
              />
            </label>
            <label className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-field/50 px-4 py-3">
              <div className="space-y-0.5">
                <div className="text-[13px] font-medium text-foreground/80">没出图也移除本地对话</div>
                <div className="text-xs leading-5 text-muted-foreground">失败、超时或只返回文本时也一并隐藏对话记录（打开后包含出图成功的情况）。</div>
              </div>
              <Switch
                checked={Boolean(config?.image_remove_conversation_always)}
                onCheckedChange={(checked) => setImageRemoveConversationAlways(Boolean(checked))}
              />
            </label>
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">图片超时继续等待时间</label>
              <Input
                value={String(config?.image_timeout_retry_secs || "30")}
                onChange={(event) => setImageTimeoutRetrySecs(event.target.value)}
                placeholder="30"
              />
              <p className="text-xs leading-5 text-muted-foreground">单位秒，超时后点击"继续等待"额外等待的时间。</p>
            </div>
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">图片二次确认等待时间</label>
              <Input
                value={String(config?.image_settle_secs || "2.0")}
                onChange={(event) => setImageSettleSecs(event.target.value)}
                placeholder="2.0"
                disabled={!config?.image_settle_enabled}
              />
              <p className="text-xs leading-5 text-muted-foreground">单位秒，找到图片后等待多久再次确认。需配合图片二次确认机制使用。</p>
            </div>
            <label className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-field/50 px-4 py-3">
              <div className="space-y-0.5">
                <div className="text-[13px] font-medium text-foreground/80">刷新后自动尝试移除异常状态</div>
                <div className="text-xs leading-5 text-muted-foreground">开启后刷新时自动尝试密码登录恢复账号。</div>
              </div>
              <Switch
                checked={Boolean(config?.auto_relogin_after_refresh)}
                onCheckedChange={(checked) => setAutoReloginAfterRefresh(Boolean(checked))}
              />
            </label>
            <label className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-field/50 px-4 py-3">
              <div className="text-[13px] font-medium text-foreground/80">自动移除限流账号</div>
              <Switch
                checked={Boolean(config?.auto_remove_rate_limited_accounts)}
                onCheckedChange={(checked) => setAutoRemoveRateLimitedAccounts(Boolean(checked))}
              />
            </label>
          </div>
        </div>

        <div className="space-y-5 border-t border-border pt-5">
          <h3 className="text-[15px] font-semibold tracking-tight">控制台日志</h3>
          <div className="space-y-3 rounded-2xl border border-border bg-field/50 p-4">
            <div>
              <div className="text-[13px] font-medium text-foreground/80">控制台日志级别</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">不选择时使用默认 info / warning / error。</p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {logLevelOptions.map((level) => (
                <label key={level} className="flex items-center gap-2 text-sm capitalize text-foreground/80">
                  <Checkbox
                    checked={Boolean(config?.log_levels?.includes(level))}
                    onCheckedChange={(checked) => setLogLevel(level, Boolean(checked))}
                  />
                  {level}
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-5 border-t border-border pt-5">
          <h3 className="text-[15px] font-semibold tracking-tight">内容与提示词</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <label className="text-[13px] font-medium text-foreground/80">全局附加指令</label>
              <Textarea
                value={String(config?.global_system_prompt || "")}
                onChange={(event) => setGlobalSystemPrompt(event.target.value)}
                placeholder="例如：先判断用户提示词是否合规；遇到违法、色情、暴力、仇恨等请求时拒绝回答。"
                className="min-h-28 font-mono text-xs"
              />
              <p className="text-xs leading-5 text-muted-foreground">每次请求都会作为 system 消息注入，可用于审核用户提示词、避免违规内容、统一约束模型行为或固定角色设定。</p>
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-[13px] font-medium text-foreground/80">敏感词</label>
              <Textarea
                value={(config?.sensitive_words || []).join("\n")}
                onChange={(event) => setSensitiveWordsText(event.target.value)}
                placeholder="一行一个，命中即拒绝"
                className="min-h-28 font-mono text-xs"
              />
              <p className="text-xs leading-5 text-muted-foreground">只要用户请求包含任意敏感词，就直接返回拒绝。</p>
            </div>
          </div>
        </div>

        <div className="space-y-5 border-t border-border pt-5">
          <h3 className="text-[15px] font-semibold tracking-tight">图片存储（WebDAV）</h3>
          <div className="space-y-4">
            <label className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-field/50 px-4 py-3">
              <div className="text-[13px] font-medium text-foreground/80">启用 WebDAV 图片存储</div>
              <Switch
                checked={Boolean(config?.image_storage?.enabled)}
                onCheckedChange={(checked) => setImageStorageField("enabled", Boolean(checked))}
              />
            </label>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void testImageStorage()}
                disabled={isTestingImageStorage || !config?.image_storage?.enabled}
              >
                {isTestingImageStorage ? <LoaderCircle className="size-4 animate-spin" /> : <Cloud className="size-4" />}
                测试 WebDAV
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void syncImagesToWebDAV()}
                disabled={isSyncingImageStorage || !config?.image_storage?.enabled || config?.image_storage?.mode === "local"}
              >
                {isSyncingImageStorage ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                全量同步
              </Button>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              生成时只处理本次新图片；全量同步用于把已有本地图片补传到 WebDAV。
            </p>
            <div className="rounded-xl border border-border bg-field/50 px-4 py-3 text-xs leading-6 text-foreground/80">
              当前待保存模式：
              <span className="ml-1 font-medium text-foreground">
                {config?.image_storage?.enabled
                  ? config.image_storage.mode === "both"
                    ? "本机 + WebDAV"
                    : config.image_storage.mode === "webdav"
                      ? "仅 WebDAV"
                      : "仅本机"
                  : "仅本机"}
              </span>
              <span className="ml-2 text-muted-foreground">修改后需要点保存，或通过测试/同步按钮自动保存。</span>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <label className="text-[13px] font-medium text-foreground/80">保存模式</label>
                <Select
                  value={String(config?.image_storage?.mode || "local")}
                  onValueChange={(value) => setImageStorageField("mode", value as ImageStorageMode)}
                  disabled={!config?.image_storage?.enabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">仅本机</SelectItem>
                    <SelectItem value="webdav">仅 WebDAV</SelectItem>
                    <SelectItem value="both">本机 + WebDAV</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 md:col-span-2">
                <label className="text-[13px] font-medium text-foreground/80">WebDAV URL</label>
                <Input
                  value={String(config?.image_storage?.webdav_url || "")}
                  onChange={(event) => setImageStorageField("webdav_url", event.target.value)}
                  placeholder="https://example.com/dav"
                  disabled={!config?.image_storage?.enabled}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[13px] font-medium text-foreground/80">用户名</label>
                <Input
                  value={String(config?.image_storage?.webdav_username || "")}
                  onChange={(event) => setImageStorageField("webdav_username", event.target.value)}
                  disabled={!config?.image_storage?.enabled}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[13px] font-medium text-foreground/80">密码</label>
                <Input
                  type="password"
                  value={String(config?.image_storage?.webdav_password || "")}
                  onChange={(event) => setImageStorageField("webdav_password", event.target.value)}
                  disabled={!config?.image_storage?.enabled}
                />
              </div>
              <div className="space-y-2">
                <label className="text-[13px] font-medium text-foreground/80">远端目录</label>
                <Input
                  value={String(config?.image_storage?.webdav_root_path || "")}
                  onChange={(event) => setImageStorageField("webdav_root_path", event.target.value)}
                  placeholder="chatgpt2api/images"
                  disabled={!config?.image_storage?.enabled}
                />
              </div>
              <div className="space-y-2 md:col-span-3">
                <label className="text-[13px] font-medium text-foreground/80">公开访问前缀</label>
                <Input
                  value={String(config?.image_storage?.public_base_url || "")}
                  onChange={(event) => setImageStorageField("public_base_url", event.target.value)}
                  placeholder="https://cdn.example.com/chatgpt2api/images"
                  disabled={!config?.image_storage?.enabled}
                />
                <p className="text-xs leading-5 text-muted-foreground">留空时返回本应用 /images/... 代理地址；填入后直接返回公开图片地址。</p>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-5 border-t border-border pt-5">
          <h3 className="text-[15px] font-semibold tracking-tight">AI 审核</h3>
          <div className="space-y-4">
            <label className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-field/50 px-4 py-3">
              <div className="space-y-0.5">
                <div className="text-[13px] font-medium text-foreground/80">启用 AI 审核</div>
                <div className="text-xs leading-5 text-muted-foreground">
                  开启后会在请求进入生图账号前先调用审核模型，审核不通过会直接拒绝，减少违规提示词触达账号造成风控或封号的风险。
                </div>
              </div>
              <Switch
                checked={Boolean(config?.ai_review?.enabled)}
                onCheckedChange={(checked) => setAIReviewField("enabled", Boolean(checked))}
              />
            </label>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <label className="text-[13px] font-medium text-foreground/80">Base URL</label>
                <Input value={String(config?.ai_review?.base_url || "")} onChange={(event) => setAIReviewField("base_url", event.target.value)} placeholder="https://api.openai.com" />
              </div>
              <div className="space-y-2">
                <label className="text-[13px] font-medium text-foreground/80">API Key</label>
                <Input value={String(config?.ai_review?.api_key || "")} onChange={(event) => setAIReviewField("api_key", event.target.value)} placeholder="sk-..." />
              </div>
              <div className="space-y-2">
                <label className="text-[13px] font-medium text-foreground/80">Model</label>
                <Input value={String(config?.ai_review?.model || "")} onChange={(event) => setAIReviewField("model", event.target.value)} placeholder="gpt-5.4-mini" />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">审核提示词</label>
              <Textarea value={String(config?.ai_review?.prompt || "")} onChange={(event) => setAIReviewField("prompt", event.target.value)} placeholder="判断用户请求是否允许。只回答 ALLOW 或 REJECT。" className="min-h-24 text-xs" />
            </div>
          </div>
        </div>

        <div className="flex justify-end border-t border-border pt-5">
          <Button
            onClick={() => void saveConfig()}
            disabled={isSavingConfig}
          >
            {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
            保存
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
