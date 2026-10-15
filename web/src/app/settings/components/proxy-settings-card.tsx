"use client";

import { useState } from "react";
import { LoaderCircle, PlugZap, Save } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { testProxy, type ProxyTestResult } from "@/lib/api";

import { useSettingsStore } from "../store";

export function ProxySettingsCard() {
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const setProxy = useSettingsStore((state) => state.setProxy);
  const saveConfig = useSettingsStore((state) => state.saveConfig);

  const proxy = config?.proxy ?? "";

  const handleTest = async () => {
    const candidate = proxy.trim();
    if (!candidate) {
      toast.error("请先填写代理地址");
      return;
    }
    setIsTesting(true);
    setTestResult(null);
    try {
      const data = await testProxy(candidate);
      setTestResult(data.result);
      if (data.result.ok) {
        toast.success(`代理可用（${data.result.latency_ms} ms，HTTP ${data.result.status}）`);
      } else {
        toast.error(`代理不可用：${data.result.error ?? "未知错误"}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "测试代理失败");
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <PlugZap className="size-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <CardTitle>全局代理</CardTitle>
            <CardDescription>为系统中的出站请求配置统一代理，保存后会立即生效。</CardDescription>
          </div>
        </div>
        <Badge variant={proxy.trim() ? "success" : "secondary"} className="w-fit shrink-0">
          {proxy.trim() ? "已配置" : "未配置"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-5 p-5">
        {isLoadingConfig ? (
          <div className="flex items-center justify-center py-10">
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">代理地址</label>
              <Input
                value={proxy}
                onChange={(event) => {
                  setProxy(event.target.value);
                  setTestResult(null);
                }}
                placeholder="http://user:pass@127.0.0.1:7890"
                className="font-mono text-xs"
              />
              <p className="text-xs leading-5 text-muted-foreground">
                留空表示不使用代理。请按完整地址填写，例如 `http://127.0.0.1:7890`、`http://用户名:密码@127.0.0.1:7890` 或 `socks5://127.0.0.1:7890`。上游 OpenAI / ChatGPT 请求，以及 CPA、sub2api、图片链接拉取、AI 审核、WebDAV、R2 备份、Means、Git 存储等其他出站请求都会使用该代理（账号代理和稳定代理运行时优先于它）；指向 127.0.0.1 / localhost 的自配置服务保持直连。
              </p>
            </div>

            {testResult ? (
              <div
                className={`rounded-xl px-3 py-2 text-xs leading-6 ${
                  testResult.ok
                    ? "bg-success/10 text-success"
                    : "bg-destructive/10 text-destructive"
                }`}
              >
                {testResult.ok
                  ? `代理可用：HTTP ${testResult.status}，用时 ${testResult.latency_ms} ms`
                  : `代理不可用：${testResult.error ?? "未知错误"}（用时 ${testResult.latency_ms} ms）`}
              </div>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => void handleTest()}
                disabled={isTesting || isLoadingConfig}
              >
                {isTesting ? <LoaderCircle className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                测试代理
              </Button>
              <Button
                onClick={() => void saveConfig()}
                disabled={isSavingConfig}
              >
                {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                保存配置
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
