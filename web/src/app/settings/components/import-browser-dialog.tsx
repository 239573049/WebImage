"use client";

import { Import, LoaderCircle, Search } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { PAGE_SIZE_OPTIONS, useSettingsStore } from "../store";

export function ImportBrowserDialog() {
  const browserOpen = useSettingsStore((state) => state.browserOpen);
  const browserPool = useSettingsStore((state) => state.browserPool);
  const remoteFiles = useSettingsStore((state) => state.remoteFiles);
  const selectedNames = useSettingsStore((state) => state.selectedNames);
  const fileQuery = useSettingsStore((state) => state.fileQuery);
  const filePage = useSettingsStore((state) => state.filePage);
  const pageSize = useSettingsStore((state) => state.pageSize);
  const isStartingImport = useSettingsStore((state) => state.isStartingImport);
  const setBrowserOpen = useSettingsStore((state) => state.setBrowserOpen);
  const toggleFile = useSettingsStore((state) => state.toggleFile);
  const replaceSelectedNames = useSettingsStore((state) => state.replaceSelectedNames);
  const setFileQuery = useSettingsStore((state) => state.setFileQuery);
  const setFilePage = useSettingsStore((state) => state.setFilePage);
  const setPageSize = useSettingsStore((state) => state.setPageSize);
  const startImport = useSettingsStore((state) => state.startImport);

  const filteredFiles = useMemo(() => {
    const query = fileQuery.trim().toLowerCase();
    if (!query) {
      return remoteFiles;
    }
    return remoteFiles.filter((item) => {
      return item.email.toLowerCase().includes(query) || item.name.toLowerCase().includes(query);
    });
  }, [fileQuery, remoteFiles]);

  const currentPageSize = Number(pageSize);
  const filePageCount = Math.max(1, Math.ceil(filteredFiles.length / currentPageSize));
  const safeFilePage = Math.min(filePage, filePageCount);
  const pagedFiles = filteredFiles.slice((safeFilePage - 1) * currentPageSize, safeFilePage * currentPageSize);
  // 用 Set 判断是否已选：全选后 selectedNames 与 filteredFiles 都是上千条，includes 会是 O(n²)，每次输入搜索词都要算一遍
  const selectedNameSet = useMemo(() => new Set(selectedNames), [selectedNames]);
  const allFilteredSelected = filteredFiles.length > 0 && filteredFiles.every((item) => selectedNameSet.has(item.name));

  const toggleSelectAllFiltered = (checked: boolean) => {
    if (checked) {
      replaceSelectedNames([...selectedNames, ...filteredFiles.map((item) => item.name)]);
      return;
    }
    const filteredSet = new Set(filteredFiles.map((item) => item.name));
    replaceSelectedNames(selectedNames.filter((name) => !filteredSet.has(name)));
  };

  return (
    <Dialog open={browserOpen} onOpenChange={setBrowserOpen}>
      <DialogContent showCloseButton={false} className="flex max-h-[85vh] max-w-5xl flex-col overflow-hidden">
        <DialogHeader className="shrink-0 gap-2">
          <DialogTitle>选择要导入的账号</DialogTitle>
          <DialogDescription className="text-sm leading-6">
            {browserPool ? `来自 ${browserPool.name || browserPool.base_url}` : "读取到的远程账号列表"}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="relative min-w-[260px]">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={fileQuery}
                onChange={(event) => setFileQuery(event.target.value)}
                placeholder="搜索 email 或文件名"
                className="pl-10"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={pageSize} onValueChange={(value) => setPageSize(value as (typeof PAGE_SIZE_OPTIONS)[number])}>
                <SelectTrigger className="w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZE_OPTIONS.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item} / 页
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                onClick={() => toggleSelectAllFiltered(!allFilteredSelected)}
              >
                {allFilteredSelected ? "取消全选" : "全选筛选结果"}
              </Button>
            </div>
          </div>

          <div className="rounded-2xl border border-border">
            <div className="flex items-center justify-between border-b border-border px-4 py-3 text-sm text-muted-foreground">
              <div className="flex items-center gap-3">
                <Checkbox checked={allFilteredSelected} onCheckedChange={(checked) => toggleSelectAllFiltered(Boolean(checked))} />
                <span>筛选结果 {filteredFiles.length} 个</span>
              </div>
              <span>已选 {selectedNames.length} 个</span>
            </div>
            <div className="max-h-[420px] overflow-auto">
              {pagedFiles.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">没有匹配的远程账号</div>
              ) : (
                <div className="divide-y divide-border">
                  {pagedFiles.map((item) => (
                    <label key={item.name} className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/60">
                      <Checkbox
                        checked={selectedNameSet.has(item.name)}
                        onCheckedChange={(checked) => toggleFile(item.name, Boolean(checked))}
                      />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-foreground/80">{item.email || item.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{item.name}</div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>
              第 {filteredFiles.length === 0 ? 0 : (safeFilePage - 1) * currentPageSize + 1} -{" "}
              {Math.min(safeFilePage * currentPageSize, filteredFiles.length)} 条，共 {filteredFiles.length} 条
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => setFilePage(Math.max(1, safeFilePage - 1))}
                disabled={safeFilePage <= 1}
              >
                上一页
              </Button>
              <span>
                {safeFilePage}/{filePageCount}
              </span>
              <Button
                variant="outline"
                onClick={() => setFilePage(Math.min(filePageCount, safeFilePage + 1))}
                disabled={safeFilePage >= filePageCount}
              >
                下一页
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter className="shrink-0 pt-2">
          <Button
            variant="secondary"
            onClick={() => setBrowserOpen(false)}
            disabled={isStartingImport}
          >
            取消
          </Button>
          <Button
            onClick={() => void startImport()}
            disabled={isStartingImport || selectedNames.length === 0}
          >
            {isStartingImport ? <LoaderCircle className="size-4 animate-spin" /> : <Import className="size-4" />}
            导入选中账号
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
