"use client";

import { Globe, LoaderCircle, Save } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import { useSettingsStore } from "../store";

export function BaseUrlCard() {
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const setBaseUrl = useSettingsStore((state) => state.setBaseUrl);
  const saveConfig = useSettingsStore((state) => state.saveConfig);

  const baseUrl = String(config?.base_url || "");

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Globe className="size-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <CardTitle>基础地址</CardTitle>
            <CardDescription>设置 `CHATGPT2API_BASE_URL` 的本地配置值，保存后立即生效。</CardDescription>
          </div>
        </div>
        <Badge variant={baseUrl.trim() ? "success" : "secondary"} className="shrink-0">
          {baseUrl.trim() ? "已配置" : "未配置"}
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
              <label className="text-[13px] font-medium text-foreground/80">Base URL</label>
              <Input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="https://example.com"
              />
              <p className="text-xs leading-5 text-muted-foreground">
                留空则使用环境变量或默认值，保存时会自动去掉首尾空格。
              </p>
            </div>

            <div className="flex justify-end">
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
