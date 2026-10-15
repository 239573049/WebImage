"use client";

import { CloudUpload, Download, Eye, HardDrive, LoaderCircle, Play, RefreshCcw, Shield, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import webConfig from "@/constants/common-env";
import { fetchBackupDetail, getBackupDownloadUrl, type BackupDetail, type BackupInclude } from "@/lib/api";
import { getStoredAuthKey } from "@/store/auth";
import { useSettingsStore } from "../store";

function formatDateTime(value?: string | null) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

function getFilenameFromContentDisposition(value: string | null) {
  const header = String(value || "").trim();
  if (!header) {
    return "";
  }
  const utf8Match = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const plainMatch = header.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plainMatch?.[1] || "";
}

const includeLabels: Array<{ key: keyof BackupInclude; label: string }> = [
  { key: "config", label: "系统配置" },
  { key: "cpa", label: "CPA 配置" },
  { key: "sub2api", label: "Sub2API 配置" },
  { key: "logs", label: "调度与调用日志" },
  { key: "image_tasks", label: "图片任务记录" },
  { key: "accounts_snapshot", label: "账号快照" },
  { key: "auth_keys_snapshot", label: "用户密钥快照" },
  { key: "images", label: "图片文件目录" },
];

export function BackupSettingsCard() {
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<BackupDetail | null>(null);
  const config = useSettingsStore((state) => state.config);
  const backups = useSettingsStore((state) => state.backups);
  const backupState = useSettingsStore((state) => state.backupState);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isSavingConfig = useSettingsStore((state) => state.isSavingConfig);
  const isLoadingBackups = useSettingsStore((state) => state.isLoadingBackups);
  const isRunningBackup = useSettingsStore((state) => state.isRunningBackup);
  const deletingBackupKey = useSettingsStore((state) => state.deletingBackupKey);
  const isTestingBackup = useSettingsStore((state) => state.isTestingBackup);
  const saveConfig = useSettingsStore((state) => state.saveConfig);
  const loadBackups = useSettingsStore((state) => state.loadBackups);
  const runBackup = useSettingsStore((state) => state.runBackup);
  const removeBackup = useSettingsStore((state) => state.removeBackup);
  const testBackup = useSettingsStore((state) => state.testBackup);
  const setBackupField = useSettingsStore((state) => state.setBackupField);
  const setBackupInclude = useSettingsStore((state) => state.setBackupInclude);

  if (isLoadingConfig) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center p-10">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const backup = config?.backup;
  if (!backup) {
    return null;
  }

  const handleOpenDetail = async (key: string) => {
    setDetailLoading(true);
    setDetailOpen(true);
    try {
      const data = await fetchBackupDetail(key);
      setDetail(data.item);
    } catch (error) {
      setDetail(null);
      toast.error(error instanceof Error ? error.message : "读取备份详情失败");
    } finally {
      setDetailLoading(false);
    }
  };

  const handleDownload = async (key: string, name: string) => {
    try {
      const authKey = await getStoredAuthKey();
      if (!authKey) {
        toast.error("当前登录态已失效，请重新登录后再下载");
        return;
      }
      const response = await fetch(`${webConfig.apiUrl.replace(/\/$/, "")}${getBackupDownloadUrl(key)}`, {
        headers: {
          Authorization: `Bearer ${authKey}`,
        },
      });
      if (!response.ok) {
        let message = "下载备份失败";
        try {
          const data = await response.json() as { detail?: { error?: string }; error?: string; message?: string };
          message = data.detail?.error || data.error || data.message || message;
        } catch {
          message = response.status === 401 ? "登录已失效，请重新登录后再试" : message;
        }
        throw new Error(message);
      }
      const downloadName = getFilenameFromContentDisposition(response.headers.get("Content-Disposition")) || name || "backup.bin";
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = downloadName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
      toast.success("备份下载已开始");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下载备份失败");
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <CloudUpload className="size-4" />
            </div>
            <div className="min-w-0 space-y-1">
              <CardTitle>R2 备份管理</CardTitle>
              <CardDescription>将关键数据定时备份到 Cloudflare R2，支持可选加密、轮替、手动执行与历史清理。</CardDescription>
            </div>
          </div>
          <Badge
            variant={backupState?.running ? "warning" : backupState?.last_status === "success" ? "success" : "secondary"}
            className="w-fit shrink-0"
          >
            {backupState?.running ? "备份中" : backupState?.last_status === "success" ? "最近成功" : backupState?.last_status === "error" ? "最近失败" : "未执行"}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-5 p-5">
          <div className="rounded-xl border border-border bg-field/50 px-4 py-3 text-sm leading-6 text-foreground/80">
            账号与用户密钥会从当前存储后端导出逻辑快照，不依赖底层是 `json`、`sqlite`、`postgres` 还是 `git`。图片目录默认不备份，避免备份体积过大。
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-field/50 px-4 py-3">
              <div className="text-[13px] font-medium text-foreground/80">启用定时备份</div>
              <Switch
                checked={Boolean(backup.enabled)}
                onCheckedChange={(checked) => setBackupField("enabled", Boolean(checked))}
              />
            </label>
            <label className="flex items-center justify-between gap-4 rounded-2xl border border-border bg-field/50 px-4 py-3">
              <div className="text-[13px] font-medium text-foreground/80">启用备份加密</div>
              <Switch
                checked={Boolean(backup.encrypt)}
                onCheckedChange={(checked) => setBackupField("encrypt", Boolean(checked))}
              />
            </label>

            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">Cloudflare Account ID</label>
              <Input value={String(backup.account_id || "")} onChange={(event) => setBackupField("account_id", event.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">Bucket 名称</label>
              <Input value={String(backup.bucket || "")} onChange={(event) => setBackupField("bucket", event.target.value)} />
            </div>

            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">Access Key ID</label>
              <Input value={String(backup.access_key_id || "")} onChange={(event) => setBackupField("access_key_id", event.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">Secret Access Key</label>
              <Input type="password" value={String(backup.secret_access_key || "")} onChange={(event) => setBackupField("secret_access_key", event.target.value)} />
            </div>

            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">备份前缀</label>
              <Input value={String(backup.prefix || "")} onChange={(event) => setBackupField("prefix", event.target.value)} placeholder="backups" />
              <p className="text-xs leading-5 text-muted-foreground">R2 内对象前缀，例如 `backups/prod`。</p>
            </div>
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">定时备份间隔</label>
              <Input value={String(backup.interval_minutes || "")} onChange={(event) => setBackupField("interval_minutes", event.target.value)} placeholder="360" />
              <p className="text-xs leading-5 text-muted-foreground">单位分钟，服务启动后会按此间隔自动轮询执行。</p>
            </div>

            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">保留备份数量</label>
              <Input value={String(backup.rotation_keep || "")} onChange={(event) => setBackupField("rotation_keep", event.target.value)} placeholder="10" />
              <p className="text-xs leading-5 text-muted-foreground">成功上传后自动删除更旧的备份。填 `0` 表示不自动轮替。</p>
            </div>
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-foreground/80">加密口令</label>
              <Input type="password" value={String(backup.passphrase || "")} onChange={(event) => setBackupField("passphrase", event.target.value)} placeholder={backup.encrypt ? "启用加密后必填" : "留空"} />
              <p className="text-xs leading-5 text-muted-foreground">仅在启用加密时使用。请妥善保管，否则无法解密备份内容。</p>
            </div>
          </div>

          <div className="space-y-5 border-t border-border pt-5">
            <div className="space-y-1">
              <h3 className="text-[15px] font-semibold tracking-tight">备份内容</h3>
              <p className="text-xs leading-5 text-muted-foreground">按组件勾选需要进入备份包的数据。</p>
            </div>
            <div className="grid gap-3 rounded-2xl border border-border bg-field/50 p-4 md:grid-cols-3">
              {includeLabels.map((item) => (
                <label key={item.key} className="flex items-center gap-3 text-sm text-foreground/80">
                  <Checkbox
                    checked={Boolean(backup.include[item.key])}
                    onCheckedChange={(checked) => setBackupInclude(item.key, Boolean(checked))}
                  />
                  {item.label}
                </label>
              ))}
            </div>
          </div>

          <div className="grid gap-4 rounded-2xl border border-border bg-field/50 p-4 text-sm text-foreground/80 md:grid-cols-3">
            <div>
              <div className="text-xs text-muted-foreground">最近开始</div>
              <div className="mt-1 font-medium text-foreground">{formatDateTime(backupState?.last_started_at)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">最近完成</div>
              <div className="mt-1 font-medium text-foreground">{formatDateTime(backupState?.last_finished_at)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">最近对象</div>
              <div className="mt-1 break-all font-medium text-foreground">{backupState?.last_object_key || "—"}</div>
            </div>
            {backupState?.last_error ? (
              <div className="md:col-span-3">
                <div className="text-xs text-destructive">最近错误</div>
                <div className="mt-1 break-all rounded-xl bg-destructive/10 px-3 py-2 text-xs leading-6 text-destructive">{backupState.last_error}</div>
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => void testBackup()} disabled={isTestingBackup}>
              {isTestingBackup ? <LoaderCircle className="size-4 animate-spin" /> : <Shield className="size-4" />}
              测试连接
            </Button>
            <Button type="button" variant="outline" onClick={() => void loadBackups()} disabled={isLoadingBackups}>
              {isLoadingBackups ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCcw className="size-4" />}
              刷新列表
            </Button>
            <Button type="button" variant="outline" onClick={() => void runBackup()} disabled={isRunningBackup || Boolean(backupState?.running)}>
              {isRunningBackup || backupState?.running ? <LoaderCircle className="size-4 animate-spin" /> : <Play className="size-4" />}
              立即备份
            </Button>
            <Button onClick={() => void saveConfig()} disabled={isSavingConfig}>
              {isSavingConfig ? <LoaderCircle className="size-4 animate-spin" /> : <CloudUpload className="size-4" />}
              保存配置
            </Button>
          </div>

          <div className="space-y-5 border-t border-border pt-5">
            <div className="space-y-1">
              <h3 className="text-[15px] font-semibold tracking-tight">历史备份</h3>
              <p className="text-xs leading-5 text-muted-foreground">支持查看对象信息并直接删除远端备份。</p>
            </div>

            {isLoadingBackups ? (
              <div className="flex items-center justify-center py-10">
                <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : backups.length === 0 ? (
              <EmptyState
                icon={<HardDrive />}
                title="暂无远端备份记录"
                description="保存配置并执行一次手动备份后会出现在这里。"
              />
            ) : (
              <div className="space-y-3">
                {backups.map((item) => {
                  const isDeleting = deletingBackupKey === item.key;
                  return (
                    <div
                      key={item.key}
                      className={`flex flex-col gap-3 rounded-2xl border border-border px-4 py-4 md:flex-row md:items-center md:justify-between ${
                        isDeleting ? "bg-destructive/10" : "bg-field/50"
                      }`}
                    >
                      <div className="min-w-0 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="break-all text-sm font-medium text-foreground">{item.name}</div>
                          {item.encrypted ? <Badge variant="secondary">已加密</Badge> : null}
                        </div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <span>大小 {formatBytes(item.size)}</span>
                          <span>更新时间 {formatDateTime(item.updated_at)}</span>
                          <span className="break-all">对象 key {item.key}</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground"
                          title="下载"
                          aria-label="下载"
                          onClick={() => void handleDownload(item.key, item.name)}
                        >
                          <Download />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground"
                          title="查看详情"
                          aria-label="查看详情"
                          onClick={() => void handleOpenDetail(item.key)}
                        >
                          <Eye />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="text-destructive hover:text-destructive"
                          title="删除"
                          aria-label="删除"
                          onClick={() => void removeBackup(item.key)}
                          disabled={isDeleting}
                        >
                          {isDeleting ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden">
          <DialogHeader className="shrink-0 border-b border-border pb-3">
            <DialogTitle>备份详情</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            {detailLoading ? (
              <div className="flex items-center justify-center py-16">
                <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : !detail ? (
              <div className="rounded-2xl border border-border bg-field/50 px-4 py-14 text-center">
                <p className="text-sm font-medium text-foreground">暂时无法读取备份详情</p>
                <p className="mt-1 text-[13px] text-muted-foreground">如果这是加密备份，请确认当前已填写正确的加密口令并先保存配置。</p>
              </div>
            ) : (
              <>
                <div className="grid gap-4 rounded-2xl border border-border bg-field/50 p-4 text-sm text-foreground/80 md:grid-cols-2">
                  <div>
                    <div className="text-xs text-muted-foreground">对象名称</div>
                    <div className="mt-1 break-all font-medium text-foreground">{detail.name}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">创建时间</div>
                    <div className="mt-1 font-medium text-foreground">{formatDateTime(detail.created_at)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">触发方式</div>
                    <div className="mt-1 font-medium text-foreground">{detail.trigger || "—"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">应用版本</div>
                    <div className="mt-1 font-medium text-foreground">{detail.app_version || "—"}</div>
                  </div>
                  <div className="md:col-span-2">
                    <div className="text-xs text-muted-foreground">存储后端</div>
                    <pre className="mt-1 overflow-x-auto rounded-xl border border-border bg-field px-3 py-2 font-mono text-xs text-foreground/80">{JSON.stringify(detail.storage_backend || {}, null, 2)}</pre>
                  </div>
                </div>

                <div className="space-y-3">
                  <h4 className="text-[15px] font-semibold tracking-tight">文件内容</h4>
                  <div className="space-y-2">
                    {detail.files.map((item) => (
                      <div key={item.name} className="rounded-2xl border border-border bg-field/50 px-4 py-3 text-sm">
                        <div className="break-all font-medium text-foreground">{item.name}</div>
                        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <span>{item.exists ? "已包含" : "缺失"}</span>
                          <span>大小 {formatBytes(item.size)}</span>
                          <span>{item.content_type || "application/octet-stream"}</span>
                          <span className="break-all">SHA256 {item.sha256 || "—"}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-3">
                  <h4 className="text-[15px] font-semibold tracking-tight">快照内容</h4>
                  <div className="grid gap-3 md:grid-cols-2">
                    {detail.snapshots.map((item) => (
                      <div key={item.name} className="rounded-2xl border border-border bg-field/50 px-4 py-3 text-sm">
                        <div className="font-medium text-foreground">{item.name}</div>
                        <div className="mt-2 text-xs text-muted-foreground">记录数 {item.count}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
