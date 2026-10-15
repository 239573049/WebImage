"use client";

import { AlertTriangle, LoaderCircle, PlugZap, Save, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  testProxy,
  testProxyClearance,
  type ClearanceTestResult,
  type ProxyRuntimeClearanceMode,
  type ProxyRuntimeEgressMode,
  type ProxyTestResult,
} from "@/lib/api";

import { useSettingsStore } from "../store";

export function ProxyRuntimeCard() {
  const [isTestingProxy, setIsTestingProxy] = useState(false);
  const [isTestingClearance, setIsTestingClearance] = useState(false);
  const [proxyResult, setProxyResult] = useState<ProxyTestResult | null>(null);
  const [clearanceResult, setClearanceResult] = useState<ClearanceTestResult | null>(null);
  const [targetUrl, setTargetUrl] = useState("https://chatgpt.com");
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const saveConfig = useSettingsStore((state) => state.saveConfig);
  const setProxyRuntimeField = useSettingsStore((state) => state.setProxyRuntimeField);
  const setProxyRuntimeClearanceField = useSettingsStore((state) => state.setProxyRuntimeClearanceField);
  const setProxyRuntimeStatusCodesText = useSettingsStore((state) => state.setProxyRuntimeStatusCodesText);

  if (isLoadingConfig || !config?.proxy_runtime) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center p-10">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const runtime = config.proxy_runtime;
  const clearance = runtime.clearance;
  const runtimeEnabled = Boolean(runtime.enabled);
  const clearanceMode = clearance.mode;
  const hasStoredClearance = Boolean(clearance.has_cf_cookies || clearance.has_cf_clearance);

  const handleTestRuntimeProxy = async () => {
    setIsTestingProxy(true);
    setProxyResult(null);
    try {
      const saved = await saveConfig();
      if (!saved) {
        return;
      }
      const data = await testProxy();
      setProxyResult(data.result);
      if (data.result.ok) {
        toast.success(`清障代理可用（${data.result.latency_ms} ms，HTTP ${data.result.status}）`);
      } else {
        toast.error(`清障代理不可用：${data.result.error ?? "未知错误"}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "测试清障代理失败");
    } finally {
      setIsTestingProxy(false);
    }
  };

  const handleTestClearance = async () => {
    setIsTestingClearance(true);
    setClearanceResult(null);
    try {
      const saved = await saveConfig();
      if (!saved) {
        return;
      }
      const data = await testProxyClearance(targetUrl.trim() || "https://chatgpt.com");
      setClearanceResult(data.result);
      if (data.result.ok) {
        toast.success(`Clearance 获取成功（${data.result.latency_ms} ms）`);
      } else {
        toast.error(`Clearance 获取失败：${data.result.error ?? data.result.status}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "测试 Clearance 失败");
    } finally {
      setIsTestingClearance(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <PlugZap className="size-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <CardTitle>FlareSolverr 清障</CardTitle>
            <CardDescription>
              默认关闭。用于上游请求遇到 Cloudflare 拦截后获取 clearance，可配合 WARP / Privoxy 代理链路重试。
            </CardDescription>
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-3 py-1 text-xs ${
            runtimeEnabled ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
          }`}
        >
          {runtimeEnabled ? "已启用" : "未启用"}
        </span>
      </CardHeader>
      <CardContent className="space-y-5 p-5">
        <div className="rounded-xl border border-border bg-field/50 px-4 py-3 text-xs leading-6 text-foreground/80">
          代理优先级：账号代理 &gt; FlareSolverr 代理链路（仅上游 OpenAI / ChatGPT 请求）&gt; 显式代理 &gt; 全局代理（其余出站请求同样使用全局代理）。Cookie / cf_clearance 不会在接口响应中明文返回。
        </div>

        <div className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/15 px-4 py-3 text-xs leading-6 text-warning">
          <AlertTriangle className="mt-1 size-4 shrink-0" />
          <span>使用 FlareSolverr 模式前，请先通过 Docker 启动 flaresolverr、privoxy、warp-proxy 等相关容器；容器内 URL 通常填写 http://flaresolverr:8191。</span>
        </div>

        <label className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-field/50 px-4 py-3">
          <div className="space-y-0.5">
            <div className="text-[13px] font-medium text-foreground/80">启用 FlareSolverr 清障</div>
          </div>
          <Switch
            checked={runtimeEnabled}
            onCheckedChange={(checked) => setProxyRuntimeField("enabled", Boolean(checked))}
          />
        </label>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <label className="text-[13px] font-medium text-foreground/80">出站模式</label>
            <Select
              value={runtime.egress_mode}
              onValueChange={(value) => setProxyRuntimeField("egress_mode", value as ProxyRuntimeEgressMode)}
              disabled={!runtimeEnabled}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="direct">直连</SelectItem>
                <SelectItem value="single_proxy">单代理/WARP</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs leading-5 text-muted-foreground">WARP compose 默认使用 single_proxy。</p>
          </div>

          <div className="space-y-2">
            <label className="text-[13px] font-medium text-foreground/80">清障代理 URL</label>
            <Input
              value={runtime.proxy_url}
              onChange={(event) => setProxyRuntimeField("proxy_url", event.target.value)}
              placeholder="http://privoxy:8118"
              disabled={!runtimeEnabled || runtime.egress_mode !== "single_proxy"}
            />
            <p className="text-xs leading-5 text-muted-foreground">
              支持 http/https/socks5/socks5h，socks5 会转为 socks5h。带认证格式：协议://账号:密码@主机:端口，也可直接粘贴 主机:端口:账号:密码。
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-[13px] font-medium text-foreground/80">资源代理 URL</label>
            <Input
              value={runtime.resource_proxy_url}
              onChange={(event) => setProxyRuntimeField("resource_proxy_url", event.target.value)}
              placeholder="留空则复用清障代理"
              disabled={!runtimeEnabled || runtime.egress_mode !== "single_proxy"}
            />
          </div>

          <div className="space-y-2">
            <label className="text-[13px] font-medium text-foreground/80">重置会话状态码</label>
            <Input
              value={runtime.reset_session_status_codes.join(",")}
              onChange={(event) => setProxyRuntimeStatusCodesText(event.target.value)}
              placeholder="403"
              disabled={!runtimeEnabled}
            />
            <p className="text-xs leading-5 text-muted-foreground">默认 403，只对 Cloudflare/挑战类错误触发。</p>
          </div>

          <label className="flex items-center justify-between gap-4 self-start rounded-2xl border border-border bg-field/50 px-4 py-3 md:col-span-2">
            <div className="space-y-0.5">
              <div className="text-[13px] font-medium text-foreground/80">跳过 SSL 校验</div>
            </div>
            <Switch
              checked={Boolean(runtime.skip_ssl_verify)}
              onCheckedChange={(checked) => setProxyRuntimeField("skip_ssl_verify", Boolean(checked))}
              disabled={!runtimeEnabled}
            />
          </label>

          <div className="flex flex-wrap items-end justify-end gap-2 md:col-span-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleTestRuntimeProxy()}
              disabled={isTestingProxy || !runtimeEnabled}
            >
              {isTestingProxy ? <LoaderCircle className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
              测试当前清障代理
            </Button>
          </div>

          {proxyResult ? (
            <div className={`rounded-xl px-3 py-2 text-xs leading-6 md:col-span-2 ${proxyResult.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
              {proxyResult.ok
                ? `代理可用：HTTP ${proxyResult.status}，用时 ${proxyResult.latency_ms} ms，来源 ${proxyResult.proxy_source ?? "unknown"}`
                : `代理不可用：${proxyResult.error ?? "未知错误"}（用时 ${proxyResult.latency_ms} ms）`}
            </div>
          ) : null}
        </div>

        <div className="space-y-5 border-t border-border pt-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h3 className="text-[15px] font-semibold tracking-tight">Cloudflare Clearance</h3>
            <span
              className={`w-fit shrink-0 rounded-full px-3 py-1 text-xs ${
                clearance.enabled ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
              }`}
            >
              {clearance.enabled ? clearanceMode : "disabled"}
            </span>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">Clearance 模式</label>
              <Select
                value={clearanceMode}
                onValueChange={(value) => {
                  const mode = value as ProxyRuntimeClearanceMode;
                  setProxyRuntimeClearanceField("mode", mode);
                  setProxyRuntimeClearanceField("enabled", mode !== "none");
                }}
                disabled={!runtimeEnabled}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不启用</SelectItem>
                  <SelectItem value="manual">手动 Cookie</SelectItem>
                  <SelectItem value="flaresolverr">FlareSolverr</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">FlareSolverr URL</label>
              <Input
                value={clearance.flaresolverr_url}
                onChange={(event) => setProxyRuntimeClearanceField("flaresolverr_url", event.target.value)}
                placeholder="http://flaresolverr:8191"
                disabled={!runtimeEnabled || clearanceMode !== "flaresolverr"}
              />
            </div>

            <div className="space-y-2 md:col-span-2">
              <label className="text-[13px] font-medium text-foreground/80">User-Agent</label>
              <Input
                value={clearance.user_agent}
                onChange={(event) => setProxyRuntimeClearanceField("user_agent", event.target.value)}
                className="font-mono text-xs"
                disabled={!runtimeEnabled || clearanceMode === "none"}
              />
            </div>

            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">超时秒数</label>
              <Input
                value={String(clearance.timeout_sec)}
                onChange={(event) => setProxyRuntimeClearanceField("timeout_sec", event.target.value)}
                placeholder="60"
                disabled={!runtimeEnabled || clearanceMode === "none"}
              />
            </div>

            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">刷新间隔秒数</label>
              <Input
                value={String(clearance.refresh_interval)}
                onChange={(event) => setProxyRuntimeClearanceField("refresh_interval", event.target.value)}
                placeholder="3600"
                disabled={!runtimeEnabled || clearanceMode === "none"}
              />
            </div>

            <div className="space-y-2 md:col-span-2">
              <label className="text-[13px] font-medium text-foreground/80">手动 Cookie</label>
              <Textarea
                value={clearance.cf_cookies}
                onChange={(event) => setProxyRuntimeClearanceField("cf_cookies", event.target.value)}
                placeholder="可选：foo=bar; cf_clearance=..."
                className="min-h-24 font-mono text-xs"
                disabled={!runtimeEnabled || clearanceMode !== "manual"}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                {hasStoredClearance ? "服务端已保存过 Cookie/clearance；留空保存不会清空已有值。" : "留空表示不使用手动 Cookie。"}
              </p>
            </div>

            <div className="space-y-2 md:col-span-2">
              <label className="text-[13px] font-medium text-foreground/80">单独 cf_clearance</label>
              <Input
                value={clearance.cf_clearance}
                onChange={(event) => setProxyRuntimeClearanceField("cf_clearance", event.target.value)}
                placeholder="可选：只填写 cf_clearance 值"
                className="font-mono text-xs"
                disabled={!runtimeEnabled || clearanceMode !== "manual"}
              />
            </div>

            <label className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-field/50 px-4 py-3 md:col-span-2">
              <div className="space-y-0.5">
                <div className="text-[13px] font-medium text-foreground/80">启动时预热 Clearance</div>
              </div>
              <Switch
                checked={Boolean(clearance.warm_up_on_start)}
                onCheckedChange={(checked) => setProxyRuntimeClearanceField("warm_up_on_start", Boolean(checked))}
                disabled={!runtimeEnabled || clearanceMode === "none"}
              />
            </label>

            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">测试目标 URL</label>
              <Input
                value={targetUrl}
                onChange={(event) => setTargetUrl(event.target.value)}
                placeholder="https://chatgpt.com"
                disabled={!runtimeEnabled || clearanceMode === "none"}
              />
            </div>

            <div className="flex flex-wrap items-end justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleTestClearance()}
                disabled={isTestingClearance || !runtimeEnabled || clearanceMode === "none"}
              >
                {isTestingClearance ? <LoaderCircle className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
                测试 Clearance
              </Button>
            </div>

            {clearanceResult ? (
              <div className={`rounded-xl px-3 py-2 text-xs leading-6 md:col-span-2 ${clearanceResult.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
                {clearanceResult.ok
                  ? `Clearance 可用：${clearanceResult.has_cookies ? "已获取 Cookie" : "无 Cookie"}，用时 ${clearanceResult.latency_ms} ms`
                  : `Clearance 不可用：${clearanceResult.error ?? clearanceResult.status}（用时 ${clearanceResult.latency_ms} ms）`}
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex justify-end">
          <Button
            type="button"
            onClick={() => void saveConfig()}
            disabled={isSavingConfig}
          >
            {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
            保存配置
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
