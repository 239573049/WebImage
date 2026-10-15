"use client";

import { Import, LoaderCircle, Pencil, Plus, ServerCog, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

import { useSettingsStore } from "../store";

export function CPAPoolsCard() {
  const pools = useSettingsStore((state) => state.pools);
  const isLoadingPools = useSettingsStore((state) => state.isLoadingPools);
  const deletingId = useSettingsStore((state) => state.deletingId);
  const loadingFilesId = useSettingsStore((state) => state.loadingFilesId);
  const openAddDialog = useSettingsStore((state) => state.openAddDialog);
  const openEditDialog = useSettingsStore((state) => state.openEditDialog);
  const deletePool = useSettingsStore((state) => state.deletePool);
  const browseFiles = useSettingsStore((state) => state.browseFiles);

  return (
    <Card>
      <CardHeader className="flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <ServerCog className="size-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <CardTitle>CPA 连接管理</CardTitle>
            <CardDescription>先配置连接，再按需查询远程账号并选择导入到本地号池。</CardDescription>
          </div>
        </div>
        <div className="flex w-fit shrink-0 items-center gap-2">
          {pools.length > 0 ? (
            <Badge variant="secondary">
              {pools.length} 个连接
            </Badge>
          ) : null}
          <Button onClick={openAddDialog}>
            <Plus className="size-4" />
            添加连接
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5 p-5">
        {isLoadingPools ? (
          <div className="flex items-center justify-center py-10">
            <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : pools.length === 0 ? (
          <EmptyState
            icon={<ServerCog />}
            title="暂无 CPA 连接"
            description="点击「添加连接」保存你的 CLIProxyAPI 信息。"
          />
        ) : (
          <div className="space-y-3">
            {pools.map((pool) => {
              const isBusy = deletingId === pool.id || loadingFilesId === pool.id;
              const importJob = pool.import_job ?? null;
              const progress = importJob?.total
                ? Math.round((importJob.completed / importJob.total) * 100)
                : 0;

              return (
                <div key={pool.id} className="flex flex-col gap-3 rounded-2xl border border-border bg-field/50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">{pool.name || pool.base_url}</div>
                      <div className="truncate text-xs text-muted-foreground">{pool.base_url}</div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground"
                        onClick={() => openEditDialog(pool)}
                        disabled={isBusy}
                        title="编辑"
                        aria-label="编辑"
                      >
                        <Pencil />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => void deletePool(pool)}
                        disabled={isBusy}
                        title="删除"
                        aria-label="删除"
                      >
                        {deletingId === pool.id ? (
                          <LoaderCircle className="animate-spin" />
                        ) : (
                          <Trash2 />
                        )}
                      </Button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      onClick={() => void browseFiles(pool)}
                      disabled={isBusy}
                    >
                      {loadingFilesId === pool.id ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <Import className="size-4" />
                      )}
                      同步
                    </Button>
                  </div>

                  {importJob ? (
                    <div className="space-y-3 rounded-xl border border-border bg-field px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground/80">
                            状态 {importJob.status}，已处理 {importJob.completed}/{importJob.total}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            任务 {importJob.job_id.slice(0, 8)} · {importJob.created_at}
                          </div>
                        </div>
                        <Badge
                          variant={
                            importJob.status === "completed"
                              ? "success"
                              : importJob.status === "failed"
                                ? "danger"
                                : "info"
                          }
                          className="shrink-0"
                        >
                          {progress}%
                        </Badge>
                      </div>
                      <div className="h-1.5 rounded-full bg-secondary">
                        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>新增 {importJob.added}</span>
                        <span>跳过 {importJob.skipped}</span>
                        <span>刷新 {importJob.refreshed}</span>
                        <span>失败 {importJob.failed}</span>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        <div className="rounded-xl border border-border bg-field/50 px-4 py-3 text-sm leading-6 text-foreground/80">
          <p className="font-medium">使用说明</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            <li>页面进入后先读取系统里已配置的 CPA 连接。</li>
            <li>点击某个连接的「同步」后，会先读取远程账号列表并展示给前端选择。</li>
            <li>确认选择后，后端后台下载对应 access_token 并导入本地号池。</li>
            <li>前端只轮询导入进度，不直接参与 download。</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
