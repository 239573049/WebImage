"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ImageIcon, LoaderCircle, RefreshCw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { DateRangeFilter } from "@/components/date-range-filter";
import { ImageLightbox } from "@/components/image-lightbox";
import { ImageThumbnail, getImageThumbnailUrl } from "@/components/image-thumbnail";
import { PageEnter } from "@/components/page-enter";
import { PageHeader } from "@/components/page-header";
import { RpmPanel } from "@/components/rpm-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { deleteSystemLogs, fetchSystemLogs, type SystemLog } from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";

const LogType = {
  Call: "call",
  Account: "account",
} as const;

const typeLabels: Record<string, string> = {
  [LogType.Call]: "调用日志",
  [LogType.Account]: "账号管理日志",
};

const pageSizeOptions = [10, 20, 50, 100];

function getDetailText(item: SystemLog, key: string) {
  const value = item.detail?.[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "-";
}

function formatDuration(item: SystemLog) {
  const value = item.detail?.duration_ms;
  return typeof value === "number" ? `${(value / 1000).toFixed(2)} s` : "-";
}

function getUrls(item: SystemLog | null) {
  const urls = item?.detail?.urls;
  return Array.isArray(urls) ? urls.filter((url): url is string => typeof url === "string") : [];
}

function isLocalImageUrl(url: string) {
  return url.includes("/images/");
}

function getStatus(item: SystemLog) {
  const status = item.detail?.status;
  if (status === "success") return "成功";
  if (status === "failed") return "失败";
  return "-";
}

function LogsContent() {
  const [items, setItems] = useState<SystemLog[]>([]);
  const [type, setType] = useState<string>(LogType.Call);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [detailLog, setDetailLog] = useState<SystemLog | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deletingItems, setDeletingItems] = useState<SystemLog[]>([]);
  const detailUrls = getUrls(detailLog);
  const detailImageUrls = detailUrls.filter(isLocalImageUrl);
  const detailLinkUrls = detailUrls.filter((url) => !isLocalImageUrl(url));
  const detailImages = detailImageUrls.map((url, index) => ({ id: `${index}`, src: url }));
  const isCallLog = type === LogType.Call;
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const currentPageSelected = items.length > 0 && items.every((item) => selectedSet.has(item.id));

  const loadLogs = async (targetPage = page) => {
    setIsLoading(true);
    try {
      const data = await fetchSystemLogs({ type, start_date: startDate, end_date: endDate, page: targetPage, page_size: pageSize });
      setItems(data.items);
      setHasMore(data.has_more);
      setPage(data.page);
      setSelectedIds((current) => current.filter((id) => data.items.some((item) => item.id === id)));
      return data;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载日志失败");
      return null;
    } finally {
      setIsLoading(false);
    }
  };

  const clearFilters = () => {
    setStartDate("");
    setEndDate("");
  };

  const openDetail = (item: SystemLog) => {
    setDetailLog(item);
    setDetailOpen(true);
  };

  const openLogImage = (item: SystemLog, index: number) => {
    setDetailLog(item);
    setLightboxIndex(index);
    setLightboxOpen(true);
  };

  const toggleIds = (ids: string[], checked: boolean) => {
    setSelectedIds((current) => checked ? Array.from(new Set([...current, ...ids])) : current.filter((id) => !ids.includes(id)));
  };

  const confirmDelete = async () => {
    const ids = deletingItems.map((item) => item.id);
    if (ids.length === 0) return;
    setIsDeleting(true);
    try {
      const data = await deleteSystemLogs(ids);
      toast.success(`已删除 ${data.removed} 条日志`);
      setDeletingItems([]);
      setSelectedIds((current) => current.filter((id) => !ids.includes(id)));
      if (detailLog && ids.includes(detailLog.id)) {
        setDetailOpen(false);
        setDetailLog(null);
      }
      // 整页被删空时回退一页，避免停在空白页
      const reloaded = await loadLogs(page);
      if (reloaded && reloaded.items.length === 0 && page > 1) {
        await loadLogs(page - 1);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除日志失败");
    } finally {
      setIsDeleting(false);
    }
  };

  useEffect(() => {
    setPage(1);
    void loadLogs(1);
  }, [type, startDate, endDate, pageSize]);

  return (
    <PageEnter className="space-y-4">
      <PageHeader
        title="日志管理"
        actions={
          <>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={LogType.Call}>调用日志</SelectItem>
                <SelectItem value={LogType.Account}>账号管理日志</SelectItem>
              </SelectContent>
            </Select>
            <DateRangeFilter startDate={startDate} endDate={endDate} onChange={(start, end) => { setStartDate(start); setEndDate(end); }} />
            <Button variant="outline" onClick={clearFilters}>
              清除筛选条件
            </Button>
            <Button onClick={() => void loadLogs()} disabled={isLoading}>
              {isLoading ? <LoaderCircle className="size-4 animate-spin" /> : <Search className="size-4" />}
              查询
            </Button>
          </>
        }
      />

      <RpmPanel />

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div className="flex flex-wrap items-center gap-3 text-sm text-foreground/80">
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox checked={currentPageSelected} onCheckedChange={(checked) => toggleIds(items.map((item) => item.id), Boolean(checked))} />
                选中当前页
              </label>
              {selectedIds.length > 0 ? <span className="text-muted-foreground">已选 {selectedIds.length} 条</span> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => void loadLogs()} disabled={isLoading}>
                <RefreshCw className={`size-4 ${isLoading ? "animate-spin" : ""}`} />
                刷新
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedIds([])} disabled={selectedIds.length === 0 || isDeleting}>
                取消选择
              </Button>
              <Button variant="tinted-destructive" size="sm" onClick={() => setDeletingItems(items.filter((item) => selectedSet.has(item.id)))} disabled={selectedIds.length === 0 || isDeleting}>
                <Trash2 className="size-4" />
                删除所选
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12"></TableHead>
                  <TableHead className="whitespace-nowrap">时间</TableHead>
                  <TableHead className="whitespace-nowrap">类型</TableHead>
                  {isCallLog ? <TableHead className="whitespace-nowrap">令牌名称</TableHead> : null}
                  {isCallLog ? <TableHead className="whitespace-nowrap">调用耗时</TableHead> : null}
                  {isCallLog ? <TableHead className="whitespace-nowrap">状态</TableHead> : null}
                  {isCallLog ? <TableHead className="w-36 whitespace-nowrap">图片</TableHead> : null}
                  <TableHead className="whitespace-nowrap">简述</TableHead>
                  <TableHead className="w-40 whitespace-nowrap">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* 行不再用 motion.tr + layout/popLayout：每页最多 100 行，每次勾选/刷新都要逐行测量布局，会明显卡顿；入场淡入改用纯 CSS */}
                <>
                  {items.map((item) => {
                    const urls = getUrls(item);
                    const imageUrls = urls.filter(isLocalImageUrl);
                    const linkUrls = urls.filter((url) => !isLocalImageUrl(url));
                    return (
                      <tr
                        key={item.id}
                        className="border-b border-border/70 text-foreground/80 transition-colors hover:bg-accent/60 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
                      >
                        <TableCell>
                          <Checkbox checked={selectedSet.has(item.id)} onCheckedChange={(checked) => toggleIds([item.id], Boolean(checked))} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{item.time}</TableCell>
                        <TableCell>
                          <Badge variant="secondary">
                            {typeLabels[item.type] || item.type}
                          </Badge>
                        </TableCell>
                        {isCallLog ? <TableCell>{getDetailText(item, "key_name")}</TableCell> : null}
                        {isCallLog ? <TableCell className="tabular-nums">{formatDuration(item)}</TableCell> : null}
                        {isCallLog ? (
                          <TableCell>
                            <Badge variant={item.detail?.status === "failed" ? "danger" : "success"}>
                              {getStatus(item)}
                            </Badge>
                          </TableCell>
                        ) : null}
                        {isCallLog ? (
                          <TableCell>
                            {urls.length ? (
                              <div className="flex flex-col gap-1">
                                {imageUrls.length ? (
                                  <div className="flex items-center gap-1.5">
                                    {imageUrls.slice(0, 3).map((url, imageIndex) => (
                                      <button
                                        key={`${url}-${imageIndex}`}
                                        type="button"
                                        className="relative size-9 overflow-hidden rounded-lg border border-border bg-muted"
                                        onClick={() => openLogImage(item, imageIndex)}
                                        title="预览图片"
                                      >
                                        <ImageThumbnail src={url} thumbnailSrc={getImageThumbnailUrl(url)} className="h-full w-full" />
                                      </button>
                                    ))}
                                    {imageUrls.length > 3 ? <span className="text-xs text-muted-foreground">+{imageUrls.length - 3}</span> : null}
                                  </div>
                                ) : null}
                                {linkUrls.slice(0, 2).map((url, linkIndex) => (
                                  <a
                                    key={`${url}-${linkIndex}`}
                                    href={url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="max-w-[140px] truncate text-xs text-primary hover:underline"
                                    title={url}
                                  >
                                    {url}
                                  </a>
                                ))}
                                {linkUrls.length > 2 ? <span className="text-xs text-muted-foreground">+{linkUrls.length - 2}</span> : null}
                              </div>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                <ImageIcon className="size-3.5" />
                                -
                              </span>
                            )}
                          </TableCell>
                        ) : null}
                        <TableCell className="max-w-[420px] truncate text-muted-foreground">{item.summary || "-"}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button variant="ghost" size="sm" onClick={() => openDetail(item)}>
                              查看详情
                            </Button>
                            <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeletingItems([item])}>
                              删除
                            </Button>
                          </div>
                        </TableCell>
                      </tr>
                    );
                  })}
                </>
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3 text-sm text-muted-foreground">
            <span className="mr-auto flex items-center gap-2">
              每页
              <Select value={String(pageSize)} onValueChange={(value) => setPageSize(Number(value))}>
                <SelectTrigger className="w-[84px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {pageSizeOptions.map((size) => (
                    <SelectItem key={size} value={String(size)}>{size}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              条
            </span>
            <span>第 {page} 页</span>
            <Button variant="outline" size="icon" disabled={page <= 1 || isLoading} onClick={() => void loadLogs(page - 1)}>
              <ChevronLeft className="size-4" />
            </Button>
            <Button variant="outline" size="icon" disabled={!hasMore || isLoading} onClick={() => void loadLogs(page + 1)}>
              <ChevronRight className="size-4" />
            </Button>
          </div>
          {!isLoading && items.length === 0 ? (
            <EmptyState
              icon={<Search />}
              title="没有找到日志"
              description="调整日志类型或日期范围后重试"
              className="border-t border-border"
            />
          ) : null}
        </CardContent>
      </Card>
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="flex h-[min(88vh,860px)] w-[min(92vw,920px)] flex-col overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b border-border px-6 py-5">
            <DialogTitle>日志详情</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="space-y-4">
              <div className="grid gap-3 rounded-2xl border border-border bg-field/50 p-4 text-sm text-foreground/80 md:grid-cols-2">
                {Object.entries(detailLog?.detail || {})
                  .filter(([key, value]) => key !== "urls" && typeof value !== "object")
                  .map(([key, value]) => (
                    <div key={key} className="flex items-start justify-between gap-4">
                      <span className="text-muted-foreground">{key}</span>
                      <span className="text-right font-medium break-all text-foreground/80">{String(value)}</span>
                    </div>
                  ))}
              </div>
              {detailLinkUrls.length ? (
                <div className="space-y-1 rounded-2xl border border-border bg-field/50 p-4 text-sm">
                  {detailLinkUrls.map((url) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer" className="block truncate text-primary hover:underline" title={url}>
                      {url}
                    </a>
                  ))}
                </div>
              ) : null}
              {detailImageUrls.length ? (
                <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
                  {detailImageUrls.map((url, index) => (
                    <button
                      key={url}
                      type="button"
                      className="aspect-square overflow-hidden rounded-xl border border-border bg-muted"
                      onClick={() => {
                        setLightboxIndex(index);
                        setLightboxOpen(true);
                      }}
                    >
                      <img src={url} alt="" className="h-full w-full object-cover" />
                    </button>
                  ))}
                </div>
              ) : null}
              <pre className="max-h-[72vh] overflow-auto rounded-xl border border-border bg-field p-4 font-mono text-xs leading-6 text-foreground/80">
                {JSON.stringify(detailLog?.detail || {}, null, 2)}
              </pre>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <ImageLightbox
        images={detailImages}
        currentIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onIndexChange={setLightboxIndex}
      />
      <Dialog open={deletingItems.length > 0} onOpenChange={(open) => (!open ? setDeletingItems([]) : null)}>
        <DialogContent showCloseButton={false} className="p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>{deletingItems.length === 1 ? "删除日志" : "删除所选日志"}</DialogTitle>
            <DialogDescription className="text-sm leading-6">
              确认删除 {deletingItems.length} 条日志吗？删除后无法恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeletingItems([])} disabled={isDeleting}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={isDeleting || deletingItems.length === 0}>
              {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : null}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageEnter>
  );
}

export default function LogsPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);
  if (isCheckingAuth || !session || session.role !== "admin") {
    return <div className="flex min-h-[40vh] items-center justify-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>;
  }
  return <LogsContent />;
}
