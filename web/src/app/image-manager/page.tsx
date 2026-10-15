"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Archive, CalendarDays, ChevronLeft, ChevronRight, Copy, Download, Eraser, HardDrive, ImageIcon, LoaderCircle, Maximize2, Plus, RefreshCw, Search, Tag, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { DateRangeFilter } from "@/components/date-range-filter";
import { ImageLightbox } from "@/components/image-lightbox";
import { PageEnter } from "@/components/page-enter";
import { PageHeader } from "@/components/page-header";
import { PageLoader } from "@/components/page-loader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatCard } from "@/components/ui/stat-card";
import { cn } from "@/lib/utils";
import { compressAllImages, deleteImageTag, deleteManagedImages, deleteToTarget, downloadImages, downloadSingleImage, fetchImageStorage, fetchImageTags, fetchManagedImages, setImageTags, type ImageStorageStats, type ManagedImage } from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";

const LONG_PRESS_MS = 800;

function formatSize(size: number) {
  return size > 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(2)} MB` : `${Math.ceil(size / 1024)} KB`;
}

function imageKey(item: ManagedImage) {
  return item.rel || item.url;
}

function useLongPress(onLongPress: () => void, ms = LONG_PRESS_MS) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);

  const start = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    activeRef.current = true;
    timerRef.current = setTimeout(() => {
      if (activeRef.current) {
        onLongPress();
      }
    }, ms);
  }, [onLongPress, ms]);

  const stop = useCallback(() => {
    activeRef.current = false;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return {
    onMouseDown: start,
    onMouseUp: stop,
    onMouseLeave: stop,
    onTouchStart: start,
    onTouchEnd: stop,
  };
}

function ImageManagerContent() {
  const [items, setItems] = useState<ManagedImage[]>([]);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [deleteStartDate, setDeleteStartDate] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ManagedImage | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [storage, setStorage] = useState<ImageStorageStats | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [compressResult, setCompressResult] = useState<string>("");
  const [targetFreeMb, setTargetFreeMb] = useState(500);

  const loadStorage = useCallback(async () => {
    try {
      setStorageLoading(true);
      const data = await fetchImageStorage();
      setStorage(data);
    } catch { /* ignore */ }
    finally { setStorageLoading(false); }
  }, []);

  useEffect(() => { void loadStorage(); }, [loadStorage]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagEditTarget, setTagEditTarget] = useState<ManagedImage | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [dialogVisible, setDialogVisible] = useState(false);
  const deleteTargetRef = useRef<ManagedImage | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [deleteMode, setDeleteMode] = useState<"selected" | "filtered" | "byDate" | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  // 图片可能有成千上万张：筛选结果、灯箱列表、全选状态都做缓存，别在每次输入标签/勾选时对全量数据重算
  const filteredItems = useMemo(
    () => selectedTags.length > 0
      ? items.filter((item) => selectedTags.every((t) => (item.tags ?? []).includes(t)))
      : items,
    [items, selectedTags],
  );

  const lightboxImages = useMemo(
    () => filteredItems.map((item) => ({
      id: item.name,
      src: item.url,
      sizeLabel: formatSize(item.size),
      dimensions: item.width && item.height ? `${item.width} x ${item.height}` : undefined,
    })),
    [filteredItems],
  );
  const pageSize = 12;
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const currentRows = filteredItems.slice((safePage - 1) * pageSize, safePage * pageSize);
  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const selectedCount = deleteMode === "filtered" ? items.length : deleteMode === "byDate" ? 0 : selectedPaths.length;
  const currentPageSelected = currentRows.length > 0 && currentRows.every((item) => selectedSet.has(imageKey(item)));
  const allSelected = useMemo(
    () => filteredItems.length > 0 && filteredItems.every((item) => selectedSet.has(imageKey(item))),
    [filteredItems, selectedSet],
  );

  const loadImages = async () => {
    setIsLoading(true);
    try {
      const [data, tagsData] = await Promise.all([
        fetchManagedImages({ start_date: startDate, end_date: endDate }),
        fetchImageTags(),
      ]);
      setItems(data.items);
      setAllTags(tagsData.tags);
      // 用 Set 过滤：全选结果后 selectedPaths 与 items 都是成千上万条，some 嵌套在 filter 里是 O(n²)
      const existingKeys = new Set(data.items.map(imageKey));
      setSelectedPaths((current) => current.filter((path) => existingKeys.has(path)));
      setPage(1);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载图片失败");
    } finally {
      setIsLoading(false);
    }
  };

  const closeDialog = useCallback(() => {
    setDialogVisible(false);
    setTimeout(() => setDeleteTarget(null), 200);
  }, []);

  const openDeleteDialog = useCallback((item: ManagedImage) => {
    deleteTargetRef.current = item;
    setDeleteTarget(item);
    setDialogVisible(true);
  }, []);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await deleteManagedImages({ paths: [deleteTarget.rel] });
      setItems((prev) => prev.filter((item) => item.rel !== deleteTarget.rel));
      setSelectedPaths((prev) => prev.filter((p) => p !== imageKey(deleteTarget)));
      toast.success("图片已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setIsDeleting(false);
      closeDialog();
    }
  };

  const handleSetTags = async (item: ManagedImage, tags: string[]) => {
    try {
      const result = await setImageTags(item.rel, tags);
      setItems((prev) => prev.map((i) => i.rel === item.rel ? { ...i, tags: result.tags } : i));
      const tagsData = await fetchImageTags();
      setAllTags(tagsData.tags);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "设置标签失败");
    }
  };

  const handleAddTag = (item: ManagedImage) => {
    const tag = tagInput.trim();
    if (!tag) return;
    const current = item.tags ?? [];
    if (current.includes(tag)) {
      toast.error("标签已存在");
      return;
    }
    void handleSetTags(item, [...current, tag]);
    setTagInput("");
  };

  const handleRemoveTag = (item: ManagedImage, tag: string) => {
    void handleSetTags(item, (item.tags ?? []).filter((t) => t !== tag));
  };

  const toggleFilterTag = (tag: string) => {
    setSelectedTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]);
    setPage(1);
  };

  const [pressingTag, setPressingTag] = useState<string | null>(null);
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tagDeleteTarget, setTagDeleteTarget] = useState<string | null>(null);

  const handleDeleteTag = async (tag: string) => {
    try {
      const result = await deleteImageTag(tag);
      setAllTags((prev) => prev.filter((t) => t !== tag));
      setSelectedTags((prev) => prev.filter((t) => t !== tag));
      setItems((prev) => prev.map((item) => ({
        ...item,
        tags: (item.tags ?? []).filter((t) => t !== tag),
      })));
      toast.success(`标签"${tag}"已删除，影响 ${result.removed_from} 张图片`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除标签失败");
    }
  };

  const startTagPress = useCallback((tag: string) => {
    setPressingTag(tag);
    pressTimerRef.current = setTimeout(() => {
      setPressingTag(null);
      setTagDeleteTarget(tag);
    }, LONG_PRESS_MS);
  }, []);

  const stopTagPress = useCallback(() => {
    setPressingTag(null);
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }, []);

  const clearFilters = () => {
    setStartDate("");
    setEndDate("");
    setSelectedTags([]);
  };

  const togglePaths = (paths: string[], checked: boolean) => {
    setSelectedPaths((current) => {
      if (checked) {
        return Array.from(new Set([...current, ...paths]));
      }
      // 取消"全选结果"时 paths 是全量数据，用 Set 避免 O(n²)
      const removed = new Set(paths);
      return current.filter((path) => !removed.has(path));
    });
  };

  const confirmDelete = async () => {
    if (!deleteMode || selectedCount === 0) return;
    setIsDeleting(true);
    try {
      const data = await deleteManagedImages(deleteMode === "filtered" ? { start_date: startDate, end_date: endDate, all_matching: true } : { paths: selectedPaths });
      toast.success(`已删除 ${data.removed} 张图片`);
      setDeleteMode(null);
      setSelectedPaths([]);
      await loadImages();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除图片失败");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleBatchDownload = async () => {
    const paths = deleteMode === "filtered" ? items.map((item) => item.rel) : selectedPaths;
    if (paths.length === 0) return;
    setIsDownloading(true);
    try {
      await downloadImages(paths);
      toast.success(`已下载 ${paths.length} 张图片`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下载失败");
    } finally {
      setIsDownloading(false);
    }
  };

  const handleSingleDownload = async (item: ManagedImage) => {
    await downloadSingleImage(item.rel);
  };

  useEffect(() => {
    void loadImages();
  }, [startDate, endDate]);

  return (
    <PageEnter className="space-y-6">
      <PageHeader
        eyebrow="Image Library"
        title="图片管理"
        description="浏览、筛选和打标签管理生成的图片，随时掌握磁盘占用并按日期清理。"
        actions={
          <>
            <DateRangeFilter startDate={startDate} endDate={endDate} onChange={(start, end) => { setStartDate(start); setEndDate(end); }} />
            <Button variant="outline" onClick={clearFilters}>
              清除筛选条件
            </Button>
            <Button onClick={() => void loadImages()} disabled={isLoading}>
              {isLoading ? <LoaderCircle className="size-4 animate-spin" /> : <Search className="size-4" />}
              查询
            </Button>
            <Button variant="tinted-destructive" onClick={() => setDeleteMode("filtered")} disabled={isDeleting || items.length === 0 || (!startDate && !endDate)}>
              <Trash2 className="size-4" />
              删除匹配日期
            </Button>
          </>
        }
      />

      {allTags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Tag className="size-3.5" />
            标签筛选：
          </span>
          {allTags.map((tag) => {
            const isPressing = pressingTag === tag;
            const isSelected = selectedTags.includes(tag);
            return (
              <span
                key={tag}
                className="relative inline-flex items-center"
                onMouseDown={() => startTagPress(tag)}
                onMouseUp={stopTagPress}
                onMouseLeave={stopTagPress}
                onTouchStart={() => startTagPress(tag)}
                onTouchEnd={stopTagPress}
              >
                <button
                  type="button"
                  className={cn(
                    "relative inline-flex items-center gap-1 overflow-hidden rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors",
                    isSelected
                      ? "bg-primary text-white hover:opacity-90"
                      : "border border-border bg-card text-foreground/80 hover:bg-accent",
                    isPressing ? "ring-2 ring-destructive/40" : "",
                  )}
                  onClick={() => toggleFilterTag(tag)}
                >
                  {isPressing ? (
                    <span className="pointer-events-none absolute inset-0 animate-[grow_800ms_linear_forwards] origin-left bg-destructive/20" />
                  ) : null}
                  <span className="relative">{tag}</span>
                </button>
              </span>
            );
          })}
          {selectedTags.length > 0 ? (
            <button
              type="button"
              onClick={() => setSelectedTags([])}
              className="inline-flex items-center gap-1 rounded-full bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/70"
            >
              <X className="size-3" />
              清除
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Storage Stats Panel */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        {storage ? (
          <>
            <StatCard
              label="磁盘总量"
              icon={<HardDrive />}
              value={storage.disk_total_mb >= 1024 ? `${(storage.disk_total_mb / 1024).toFixed(1)} GB` : `${storage.disk_total_mb} MB`}
            />
            <StatCard
              label="剩余空间"
              icon={<HardDrive />}
              tone={storage.disk_free_mb < 200 ? "danger" : storage.disk_free_mb < 500 ? "warning" : "success"}
              value={storage.disk_free_mb >= 1024 ? `${(storage.disk_free_mb / 1024).toFixed(1)} GB` : `${storage.disk_free_mb} MB`}
            />
            <StatCard label="图片数量" icon={<ImageIcon />} value={storage.image_count} />
            <StatCard
              label="图片占用"
              icon={<ImageIcon />}
              value={storage.image_size_mb >= 1024 ? `${(storage.image_size_mb / 1024).toFixed(1)} GB` : `${storage.image_size_mb} MB`}
            />
            <Card className="col-span-2">
              <CardContent className="space-y-3 p-5">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[13px] text-muted-foreground">快捷操作</div>
                  <span className="flex size-7 items-center justify-center rounded-xl bg-primary/15 text-primary">
                    <RefreshCw className="size-4" />
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" disabled={storageLoading} onClick={() => { void loadStorage(); }}>
                    <RefreshCw className={cn("size-3.5", storageLoading && "animate-spin")} />
                    刷新
                  </Button>
                  <Button size="sm" variant="outline"
                    onClick={async () => {
                      try { const r = await compressAllImages(); setCompressResult(`已压缩${r.saved_mb}MB`); void loadStorage(); }
                      catch { setCompressResult("压缩失败"); }
                    }}>
                    <Archive className="size-3.5" />
                    压缩优化
                  </Button>
                  <Button size="sm" variant="tinted-destructive"
                    onClick={() => setDeleteMode("byDate")}>
                    <Trash2 className="size-3.5" />
                    按日期删除
                  </Button>
                  <form onSubmit={async (e) => { e.preventDefault();
                    try {
                      const r = await deleteToTarget(targetFreeMb);
                      toast.success(`已删除 ${r.removed} 张图片，释放 ${r.freed_mb ?? 0}MB`);
                      void loadStorage();
                    } catch { toast.error("清理失败"); }
                  }} className="flex items-center gap-1.5">
                    <Button size="sm" variant="outline" type="submit">
                      <Eraser className="size-3.5" />
                      清理至
                    </Button>
                    <Input className="w-14 px-1 text-center" type="number" min={50} value={targetFreeMb}
                      onChange={(e) => setTargetFreeMb(Number(e.target.value) || 500)} />
                    <span className="text-xs text-muted-foreground">MB 剩余</span>
                  </form>
                  {compressResult ? <span className="text-xs text-success">{compressResult}</span> : null}
                </div>
              </CardContent>
            </Card>
          </>
        ) : (
          <Card className="col-span-full">
            <CardContent className="p-5 text-center text-sm text-muted-foreground">
              {storageLoading ? "加载存储信息..." : "存储信息加载失败"}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Delete by date dialog */}
      <Dialog open={deleteMode === "byDate"} onOpenChange={() => setDeleteMode(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>按日期删除图片</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <label className="shrink-0 text-sm text-foreground/80">删除</label>
              <Input type="date" value={deleteStartDate} onChange={(e) => setDeleteStartDate(e.target.value)} />
              <span className="text-sm text-muted-foreground">之前的图片</span>
            </div>
            <p className="text-xs text-muted-foreground">此操作不可撤销，将永久删除所有匹配日期的图片及其缩略图。</p>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeleteMode(null)}>取消</Button>
            <Button variant="destructive" disabled={!deleteStartDate || isDeleting}
              onClick={async () => {
                if (!deleteStartDate) return;
                try {
                  setIsDeleting(true);
                  const r = await deleteManagedImages({ end_date: deleteStartDate, all_matching: true });
                  toast.success(`已删除 ${r.removed} 张图片`);
                  setDeleteMode(null);
                  void loadStorage();
                  void loadImages();
                } catch { toast.error("删除失败"); }
                finally { setIsDeleting(false); }
              }}>
              {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : null}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div className="flex flex-wrap items-center gap-3 text-sm text-foreground/80">
              <span className="flex items-center gap-1.5">
                <ImageIcon className="size-4 text-muted-foreground" />
                共 {filteredItems.length} 张
                {selectedTags.length > 0 ? <span className="text-muted-foreground">（筛选自 {items.length} 张）</span> : null}
              </span>
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox checked={currentPageSelected} onCheckedChange={(checked) => togglePaths(currentRows.map(imageKey), Boolean(checked))} />
                本页全选
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox checked={allSelected} onCheckedChange={(checked) => togglePaths(filteredItems.map(imageKey), Boolean(checked))} />
                全选结果
              </label>
              {selectedPaths.length > 0 ? <span className="text-muted-foreground">已选 {selectedPaths.length} 张</span> : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => void loadImages()} disabled={isLoading}>
                <RefreshCw className={`size-4 ${isLoading ? "animate-spin" : ""}`} />
                刷新
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedPaths([])} disabled={selectedPaths.length === 0 || isDeleting}>
                取消选择
              </Button>
              <Button variant="outline" size="sm" onClick={() => void handleBatchDownload()} disabled={selectedPaths.length === 0 || isDownloading || isDeleting}>
                {isDownloading ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
                下载所选
              </Button>
              <Button variant="tinted-destructive" size="sm" onClick={() => setDeleteMode("selected")} disabled={selectedPaths.length === 0 || isDeleting}>
                <Trash2 className="size-4" />
                删除所选
              </Button>
            </div>
          </div>
          <div className="grid gap-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {currentRows.map((item, rowIndex) => {
              // 当前页第 rowIndex 张在筛选结果里的下标（不要再对全量数据做 findIndex）
              const imageIndex = (safePage - 1) * pageSize + rowIndex;
              return (
              <div key={item.rel} className="group border-r border-b border-border p-4 transition-colors hover:bg-accent/60">
                <div className="relative">
                  <button
                    type="button"
                    className="relative block aspect-square w-full cursor-zoom-in overflow-hidden rounded-2xl bg-muted text-left"
                    onClick={() => {
                      setLightboxIndex(imageIndex);
                      setLightboxOpen(true);
                    }}
                  >
                    <img
                      src={item.thumbnail_url || item.url}
                      alt={item.name}
                      className="h-full w-full object-cover"
                      onError={(event) => {
                        if (event.currentTarget.src !== item.url) {
                          event.currentTarget.src = item.url;
                        }
                      }}
                    />
                    <span className="absolute right-2 bottom-2 rounded-full bg-black/50 p-2 text-white opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                      <Maximize2 className="size-4" />
                    </span>
                  </button>
                  <button
                    type="button"
                    className="absolute top-2 right-2 z-10 inline-flex size-7 items-center justify-center rounded-full bg-black/50 text-white opacity-100 transition-[background-color,opacity] hover:bg-destructive/90 sm:opacity-0 sm:group-hover:opacity-100"
                    title="删除图片"
                    onClick={(e) => {
                      e.stopPropagation();
                      openDeleteDialog(item);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
                <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1 font-medium text-foreground/80">
                      <CalendarDays className="size-3.5 shrink-0" />
                      <span className="truncate">{item.created_at}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground"
                        onClick={() => void handleSingleDownload(item)}
                        title="下载图片"
                      >
                        <Download className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground"
                        onClick={() => {
                          void navigator.clipboard.writeText(item.url);
                          toast.success("图片地址已复制");
                        }}
                      >
                        <Copy className="size-4" />
                      </Button>
                      <Checkbox checked={selectedSet.has(imageKey(item))} onCheckedChange={(checked) => togglePaths([imageKey(item)], Boolean(checked))} />
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span>{formatSize(item.size)}</span>
                    <span>{item.width && item.height ? `${item.width} x ${item.height}` : "-"}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {(item.tags ?? []).map((tag) => (
                      <Badge key={tag} variant="secondary" className="gap-0.5 py-0 pr-0.5 text-[10px]">
                        {tag}
                        <button
                          type="button"
                          className="inline-flex size-3.5 items-center justify-center rounded-full hover:bg-secondary/70"
                          onClick={() => handleRemoveTag(item, tag)}
                        >
                          <X className="size-2.5" />
                        </button>
                      </Badge>
                    ))}
                    <Popover open={tagEditTarget?.rel === item.rel} onOpenChange={(open) => { setTagEditTarget(open ? item : null); setTagInput(""); }}>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex size-5 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground hover:border-input hover:text-foreground/80"
                          title="添加标签"
                        >
                          <Plus className="size-3" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-56 p-2">
                        <div className="space-y-2">
                          <div className="text-xs font-medium text-muted-foreground">添加标签</div>
                          <div className="flex gap-1">
                            <Input
                              value={tagInput}
                              onChange={(e) => setTagInput(e.target.value)}
                              placeholder="输入标签名"
                              className="h-8 text-xs"
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  handleAddTag(item);
                                }
                              }}
                            />
                            <Button
                              size="icon-sm"
                              variant="outline"
                              className="shrink-0"
                              onClick={() => handleAddTag(item)}
                            >
                              <Plus className="size-3.5" />
                            </Button>
                          </div>
                          {allTags.filter((t) => !(item.tags ?? []).includes(t)).length > 0 ? (
                            <div className="flex flex-wrap gap-1 border-t border-border pt-2">
                              {allTags.filter((t) => !(item.tags ?? []).includes(t)).map((tag) => (
                                <button
                                  key={tag}
                                  type="button"
                                  onClick={() => {
                                    void handleSetTags(item, [...(item.tags ?? []), tag]);
                                    setTagEditTarget(null);
                                  }}
                                >
                                  <Badge variant="outline" className="cursor-pointer text-[10px] hover:bg-accent">
                                    {tag}
                                  </Badge>
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
              </div>
            )})}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3 text-sm text-muted-foreground">
            <span>第 {safePage} / {pageCount} 页，共 {filteredItems.length} 张</span>
            <Button variant="outline" size="icon" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              <ChevronLeft className="size-4" />
            </Button>
            <Button variant="outline" size="icon" disabled={safePage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>
              <ChevronRight className="size-4" />
            </Button>
          </div>
          {!isLoading && filteredItems.length === 0 ? (
            <EmptyState icon={<ImageIcon />} title="没有找到图片" description="调整日期范围或标签筛选后重试" className="border-t border-border" />
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={dialogVisible} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="max-w-sm overflow-hidden">
          <DialogHeader>
            <DialogTitle className="pr-8">确认删除</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-foreground/80">
            确定要删除这张图片吗？此操作不可恢复。
          </p>
          {deleteTarget ? (
            <div className="flex items-center gap-3 overflow-hidden rounded-2xl border border-border bg-field/50 p-3">
              <img
                src={deleteTarget.thumbnail_url || deleteTarget.url}
                alt=""
                className="size-16 shrink-0 rounded-xl object-cover"
                onError={(e) => { if (e.currentTarget.src !== deleteTarget.url) e.currentTarget.src = deleteTarget.url; }}
              />
              <div className="min-w-0 overflow-hidden text-xs text-muted-foreground">
                <div className="truncate font-medium text-foreground/80">{deleteTarget.name}</div>
                <div className="truncate">{deleteTarget.created_at}</div>
                <div>{formatSize(deleteTarget.size)}</div>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="secondary" onClick={closeDialog}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={isDeleting}>
              {isDeleting ? <LoaderCircle className="mr-1 size-4 animate-spin" /> : <Trash2 className="mr-1 size-4" />}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImageLightbox
        images={lightboxImages}
        currentIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onIndexChange={setLightboxIndex}
      />
      <Dialog open={deleteMode === "selected" || deleteMode === "filtered"} onOpenChange={(open) => (!open ? setDeleteMode(null) : null)}>
        <DialogContent showCloseButton={false} className="p-6">
          <DialogHeader className="gap-2">
            <DialogTitle>{deleteMode === "filtered" ? "删除匹配日期的图片" : "删除所选图片"}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-foreground/80">
            确认删除 {selectedCount} 张图片吗？删除后无法恢复。
          </p>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeleteMode(null)} disabled={isDeleting}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={isDeleting || selectedCount === 0}>
              {isDeleting ? <LoaderCircle className="size-4 animate-spin" /> : null}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={Boolean(tagDeleteTarget)} onOpenChange={(open) => { if (!open) setTagDeleteTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>删除标签</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-foreground/80">
            确定要删除标签 <span className="font-semibold">"{tagDeleteTarget}"</span> 吗？将从所有图片中移除该标签。
          </p>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setTagDeleteTarget(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (tagDeleteTarget) void handleDeleteTag(tagDeleteTarget);
                setTagDeleteTarget(null);
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageEnter>
  );
}

export default function ImageManagerPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);
  if (isCheckingAuth || !session || session.role !== "admin") {
    return <PageLoader />;
  }
  return <ImageManagerContent />;
}
