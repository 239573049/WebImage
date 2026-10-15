"use client";

import { ExternalLink, LoaderCircle, Save } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

import { useSettingsStore } from "../store";

export function ThirdPartyAppsCard() {
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const setInfiniteCanvasField = useSettingsStore((state) => state.setInfiniteCanvasField);
  const saveConfig = useSettingsStore((state) => state.saveConfig);

  if (isLoadingConfig || !config?.third_party_apps) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center p-10">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const canvas = config.third_party_apps.infinite_canvas;

  return (
    <Card>
      <CardHeader className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <ExternalLink className="size-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <CardTitle>无限画布入口</CardTitle>
            <CardDescription>开启后会在顶部导航显示入口，跳转时自动附带本项目地址和当前密钥。</CardDescription>
          </div>
        </div>
        <Badge variant={canvas.enabled ? "success" : "secondary"} className="w-fit shrink-0">
          {canvas.enabled ? "已启用" : "未启用"}
        </Badge>
      </CardHeader>
      <CardContent className="space-y-5 p-5">
        <label className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-field/50 px-4 py-3">
          <div className="text-[13px] font-medium text-foreground/80">启用无限画布</div>
          <Switch
            checked={Boolean(canvas.enabled)}
            onCheckedChange={(checked) => setInfiniteCanvasField("enabled", Boolean(checked))}
          />
        </label>

        <div className="space-y-2">
          <label className="text-[13px] font-medium text-foreground/80">无限画布地址</label>
          <Input
            value={canvas.url}
            onChange={(event) => setInfiniteCanvasField("url", event.target.value)}
            placeholder="https://canvas.best"
          />
          <p className="text-xs leading-5 text-muted-foreground">
            顶部入口跳转时会追加 apiKey 和 baseUrl 参数；关闭后顶部导航不显示无限画布。
          </p>
          <p className="text-xs leading-5 text-warning">
            该入口仅供个人测试使用；长期使用建议自行本机部署无限画布。
          </p>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => void saveConfig()} disabled={isSavingConfig}>
            {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
            保存
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
