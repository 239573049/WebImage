"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Clock3, Download, EyeOff, LoaderCircle, RotateCcw, Sparkles, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ImageConversation, ImageTurn, ImageTurnStatus, StoredImage, StoredReferenceImage } from "@/store/image-conversations";

export type ImageLightboxItem = {
  id: string;
  src: string;
  sizeLabel?: string;
  dimensions?: string;
};

type ImageResultsProps = {
  selectedConversation: ImageConversation | null;
  onOpenLightbox: (images: ImageLightboxItem[], index: number) => void;
  onContinueEdit: (conversationId: string, image: StoredImage | StoredReferenceImage) => void;
  onDeletePrompt: (conversationId: string, turnId: string) => void;
  onDeleteResults: (conversationId: string, turnId: string) => void;
  onReuseTurnConfig: (conversationId: string, turnId: string) => void | Promise<void>;
  onRegenerateTurn: (conversationId: string, turnId: string) => void | Promise<void>;
  onRetryImage: (conversationId: string, turnId: string, imageId: string) => void | Promise<void>;
  onTimeoutRetryContinue: (taskId: string) => void | Promise<void>;
  onDismissErrors: (conversationId: string, turnId: string) => void | Promise<void>;
  formatConversationTime: (value: string) => string;
};

/** base64 → 字节。优先用原生 Uint8Array.fromBase64（不经过中间字符串，快一个数量级），不支持时回退到 atob。 */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as unknown as { fromBase64?: (input: string) => Uint8Array<ArrayBuffer> }).fromBase64;
  if (typeof native === "function") {
    try {
      return native.call(Uint8Array, base64);
    } catch {
      // 极少数格式不被原生实现接受时，退回到更宽松的 atob
    }
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Blob URL 缓存：避免 base64 超长字符串在 DOM 中，改用短小的 blob: URL
const b64BlobUrlCache = new Map<string, string>();

function getStoredImageSrc(image: StoredImage) {
  if (image.b64_json) {
    let url = b64BlobUrlCache.get(image.b64_json);
    if (!url) {
      const blob = new Blob([base64ToBytes(image.b64_json)], { type: "image/png" });
      url = URL.createObjectURL(blob);
      b64BlobUrlCache.set(image.b64_json, url);
    }
    return url;
  }
  return image.url || "";
}

function hasImageData(image: StoredImage) {
  return Boolean(image.b64_json || image.url);
}

// 图片加载完成后记下的自然尺寸。放在模块级：不触发整页重渲染，切换会话/打开灯箱时也能直接取到。
const imageDimensions = new Map<string, string>();

/**
 * 灯箱条目：src 用惰性 getter，只有真正显示到这一张时才解码 base64，
 * 避免点开一张图就把整轮（可能上百张）的图片全部同步解码一遍。
 */
function toLightboxItem(image: StoredImage): ImageLightboxItem {
  return {
    id: image.id,
    get src() {
      return getStoredImageSrc(image);
    },
    sizeLabel: image.b64_json ? formatBase64ImageSize(image.b64_json) : undefined,
    dimensions: imageDimensions.get(image.id),
  };
}

async function downloadStoredImage(image: StoredImage, index: number) {
  let blob: Blob | null = null;
  try {
    if (image.b64_json) {
      blob = new Blob([base64ToBytes(image.b64_json)], { type: "image/png" });
    } else if (image.url) {
      // 确保 URL 是绝对路径
      const url = image.url.startsWith("http") ? image.url : `${window.location.origin}${image.url}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      blob = await res.blob();
    } else {
      return;
    }
  } catch (err) {
    console.error("Failed to download image:", err);
    // 如果 fetch 失败，尝试直接在新窗口打开
    if (image.url) {
      window.open(image.url, "_blank");
    }
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `image-${index + 1}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// 计时器：整个页面共用一个 500ms 的 interval，只让真正显示耗时的小标签重渲染。
// 以前是在 ImageResults 里 setState 每 500ms 重渲染整个会话（所有轮次、所有图片）。
// ---------------------------------------------------------------------------
const TICK_MS = 500;
const tickListeners = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | null = null;

function subscribeTick(listener: () => void) {
  tickListeners.add(listener);
  if (tickTimer === null) {
    tickTimer = setInterval(() => tickListeners.forEach((notify) => notify()), TICK_MS);
  }
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0 && tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
}

// 按 TICK_MS 取整：同一个时间片内多次读取得到同一个值，useSyncExternalStore 才不会反复重渲染
const getTickSnapshot = () => Math.floor(Date.now() / TICK_MS) * TICK_MS;
const getServerTickSnapshot = () => 0;

function ElapsedLabel({ elapsedSecs, elapsedUpdatedAt }: { elapsedSecs: number; elapsedUpdatedAt?: number }) {
  const now = useSyncExternalStore(subscribeTick, getTickSnapshot, getServerTickSnapshot);
  const seconds = elapsedUpdatedAt != null ? elapsedSecs + Math.max(0, now - elapsedUpdatedAt) / 1000 : elapsedSecs;
  return <div className="px-0.5 py-1 text-[10px] text-muted-foreground sm:px-3 sm:py-3 sm:text-xs">{formatElapsed(seconds)}</div>;
}

// ---------------------------------------------------------------------------

export const ImageResults = memo(function ImageResults({
  selectedConversation,
  onOpenLightbox,
  onContinueEdit,
  onDeletePrompt,
  onDeleteResults,
  onReuseTurnConfig,
  onRegenerateTurn,
  onRetryImage,
  onTimeoutRetryContinue,
  onDismissErrors,
  formatConversationTime,
}: ImageResultsProps) {
  if (!selectedConversation) {
    return (
      <div className="flex h-full min-h-[260px] items-center justify-center text-center sm:min-h-[420px]">
        <div className="w-full max-w-4xl">
          <h1
            className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl md:text-5xl"
            style={{
              fontFamily: '"Palatino Linotype","Book Antiqua","URW Palladio L","Times New Roman",serif',
            }}
          >
            Turn ideas into images
          </h1>
          <p
            className="mx-auto mt-3 max-w-[280px] text-sm italic tracking-[0.01em] text-muted-foreground sm:mt-4 sm:max-w-none sm:text-[15px]"
            style={{
              fontFamily: '"Palatino Linotype","Book Antiqua","URW Palladio L","Times New Roman",serif',
            }}
          >
            在同一窗口里保留本地历史与任务状态，并从已有结果图继续发起新的无状态编辑。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-5 sm:gap-8">
      {selectedConversation.turns.map((turn, turnIndex) => (
        <TurnView
          key={turn.id}
          conversationId={selectedConversation.id}
          turn={turn}
          turnIndex={turnIndex}
          onOpenLightbox={onOpenLightbox}
          onContinueEdit={onContinueEdit}
          onDeletePrompt={onDeletePrompt}
          onDeleteResults={onDeleteResults}
          onReuseTurnConfig={onReuseTurnConfig}
          onRegenerateTurn={onRegenerateTurn}
          onRetryImage={onRetryImage}
          onTimeoutRetryContinue={onTimeoutRetryContinue}
          onDismissErrors={onDismissErrors}
          formatConversationTime={formatConversationTime}
        />
      ))}
    </div>
  );
});

type TurnViewProps = Omit<ImageResultsProps, "selectedConversation"> & {
  conversationId: string;
  turn: ImageTurn;
  turnIndex: number;
};

/**
 * 单个轮次。用 memo 隔离：轮询只会替换正在生成的那一轮的对象，
 * 其余历史轮次引用不变，整轮（提示词、参考图、全部结果图）都不会重渲染。
 */
const TurnView = memo(function TurnView({
  conversationId,
  turn,
  turnIndex,
  onOpenLightbox,
  onContinueEdit,
  onDeletePrompt,
  onDeleteResults,
  onReuseTurnConfig,
  onRegenerateTurn,
  onRetryImage,
  onTimeoutRetryContinue,
  onDismissErrors,
  formatConversationTime,
}: TurnViewProps) {
  const referenceLightboxImages = useMemo(
    () =>
      turn.referenceImages.map((image, index) => ({
        id: `${turn.id}-reference-${index}`,
        src: image.dataUrl,
      })),
    [turn.id, turn.referenceImages],
  );

  // 灯箱条目在点击时才构建（而不是每次渲染都为整轮图片计算一遍）
  const openResultImage = useCallback(
    (imageId: string) => {
      const items = turn.images.filter((image) => image.status === "success" && hasImageData(image)).map(toLightboxItem);
      onOpenLightbox(items, items.findIndex((item) => item.id === imageId));
    },
    [turn.images, onOpenLightbox],
  );

  return (
    <div className="flex flex-col gap-3 sm:gap-4">
      {!turn.promptDeleted ? (
        <div className="flex justify-end">
          <div className="flex max-w-[90%] flex-col items-end px-1 py-1 sm:max-w-[82%]">
            <div className="mb-1.5 flex flex-wrap justify-end gap-2 text-[11px] text-muted-foreground sm:mb-2">
              <span>第 {turnIndex + 1} 轮</span>
              <span>
                {turn.mode === "edit" ? "编辑图" : "文生图"}
              </span>
              <span>{getTurnStatusLabel(turn.status)}</span>
              <span>{formatConversationTime(turn.createdAt)}</span>
            </div>
            <div className="rounded-[20px] rounded-br-md bg-primary px-4 py-2.5 text-left text-[14px] leading-6 text-white sm:text-[15px] sm:leading-7">
              {turn.prompt}
            </div>
            <div className="mt-2 flex flex-wrap justify-end gap-1.5">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="rounded-full px-2.5 text-[11px]"
                onClick={() => void onReuseTurnConfig(conversationId, turn.id)}
              >
                复用配置
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-6 rounded-full text-muted-foreground hover:text-destructive"
                onClick={() => onDeletePrompt(conversationId, turn.id)}
                aria-label="删除提示词记录"
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {!turn.resultsDeleted ? (
        <div className="flex justify-start">
          <div className="w-full p-1">
            {turn.referenceImages.length > 0 ? (
              <div className="mb-4 flex flex-col items-end">
                <div className="mb-3 text-xs font-medium text-muted-foreground">本轮参考图</div>
                <div className="flex flex-wrap justify-end gap-3">
                  {turn.referenceImages.map((image, index) => (
                    <div key={`${turn.id}-${image.name}-${index}`} className="flex flex-col items-end gap-2">
                      <button
                        type="button"
                        onClick={() => onOpenLightbox(referenceLightboxImages, index)}
                        className="group relative h-24 w-24 overflow-hidden rounded-2xl border border-border bg-muted text-left transition-colors hover:border-border"
                        aria-label={`预览参考图 ${image.name || index + 1}`}
                      >
                        <img
                          src={image.dataUrl}
                          alt={image.name || `参考图 ${index + 1}`}
                          decoding="async"
                          className="absolute inset-0 h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                        />
                      </button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-full"
                        onClick={() => onContinueEdit(conversationId, image)}
                      >
                        <Sparkles className="size-4" />
                        加入编辑
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground sm:mb-4 sm:gap-2 sm:text-xs">
              <Badge variant="secondary">{turn.count} 张</Badge>
              <Badge variant="secondary">{getTurnStatusLabel(turn.status)}</Badge>
              {turn.status === "queued" ? (
                <Badge variant="warning">等待当前对话中的前序任务完成</Badge>
              ) : null}
            </div>

            <div className="grid grid-cols-3 gap-2 sm:block sm:columns-2 sm:gap-4 sm:space-y-4 xl:columns-3">
              {turn.images.map((image, index) => {
                if (image.status === "success" && hasImageData(image)) {
                  return (
                    <SuccessImageCard
                      key={image.id}
                      conversationId={conversationId}
                      image={image}
                      index={index}
                      onOpen={openResultImage}
                      onContinueEdit={onContinueEdit}
                    />
                  );
                }

                if (image.status === "error") {
                  const isTimeoutError = image.error?.includes("超时") && image.taskId;
                  return (
                    <div key={image.id} className="break-inside-avoid">
                      <div
                        className={cn(
                          "overflow-hidden rounded-2xl border border-destructive/30 bg-destructive/10 text-destructive",
                          "aspect-square",
                          turn.ratio === "1:1" && "sm:aspect-square",
                          turn.ratio === "16:9" && "sm:aspect-video",
                          turn.ratio === "9:16" && "sm:aspect-[9/16]",
                          turn.ratio === "4:3" && "sm:aspect-[4/3]",
                          turn.ratio === "3:4" && "sm:aspect-[3/4]",
                        )}
                      >
                      <div className="flex h-full min-h-16 flex-col items-center justify-center gap-1.5 px-2 py-2 text-center text-[11px] leading-4 text-destructive sm:gap-3 sm:px-6 sm:py-8 sm:text-sm sm:leading-6">
                        <p className="font-medium">图片 {index + 1}/{turn.images.length}</p>
                        <span className="line-clamp-2 sm:line-clamp-none">{image.error || "生成失败"}</span>
                        <div className="flex items-center gap-2">
                          {isTimeoutError && (
                            <button
                              type="button"
                              onClick={() => void onTimeoutRetryContinue(image.taskId!)}
                              className="rounded-full bg-success/15 px-2 py-1 text-[10px] font-medium text-success transition-colors hover:bg-success/25 sm:px-3 sm:text-xs"
                            >
                              继续等待
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void onRetryImage(conversationId, turn.id, image.id)}
                            className="rounded-full bg-card px-2 py-1 text-[10px] font-medium text-destructive transition-colors hover:bg-accent sm:px-3 sm:text-xs"
                          >
                            重新生成这一张
                          </button>
                        </div>
                      </div>
                      </div>
                      <div className="flex flex-col gap-1 px-0.5 py-1 text-[10px] sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:px-3 sm:py-3 sm:text-xs">
                        <div className="min-w-0 text-muted-foreground">
                          <span>结果 {index + 1}</span>
                          {image.durationMs != null ? <span className="text-muted-foreground sm:ml-2">{formatDuration(image.durationMs)}</span> : null}
                          <span className="block text-transparent">-</span>
                        </div>
                      </div>
                    </div>
                  );
                }

                const imageTaskStatus = image.taskStatus || (turn.status === "queued" ? "queued" : "running");
                const imageStatusLabel = imageTaskStatus === "queued" ? "排队中" : getProgressLabel(image.progress);
                const showElapsed = imageTaskStatus === "running" && image.elapsedSecs != null;
                return (
                  <div key={image.id} className="break-inside-avoid">
                    <div
                      className={cn(
                        "relative overflow-hidden rounded-2xl border border-border bg-muted",
                        turn.ratio === "1:1" && "aspect-square",
                        turn.ratio === "16:9" && "aspect-video",
                        turn.ratio === "9:16" && "aspect-[9/16]",
                        turn.ratio === "4:3" && "aspect-[4/3]",
                        turn.ratio === "3:4" && "aspect-[3/4]",
                      )}
                    >
                    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-2 py-3 text-center text-muted-foreground sm:gap-3 sm:px-6 sm:py-8">
                      <div className="rounded-full border border-border bg-card p-2 sm:p-3">
                        {imageTaskStatus === "queued" ? (
                          <Clock3 className="size-4 sm:size-5" />
                        ) : (
                          <LoaderCircle className="size-4 animate-spin sm:size-5" />
                        )}
                      </div>
                      <p className="text-[11px] font-medium leading-4 sm:text-sm">
                        图片 {index + 1}/{turn.images.length}
                      </p>
                      <p className="text-[10px] leading-4 text-muted-foreground sm:text-xs">
                        {imageStatusLabel}
                      </p>
                    </div>
                    </div>
                    {showElapsed ? (
                      <ElapsedLabel elapsedSecs={image.elapsedSecs!} elapsedUpdatedAt={image.elapsedUpdatedAt} />
                    ) : null}
                  </div>
                );
              })}
            </div>

            {turn.status === "error" && turn.error ? (
              <div className="mt-4 flex items-center justify-between rounded-r-xl border-l-2 border-warning bg-warning/10 px-4 py-3 text-sm leading-6 text-warning">
                <span>{turn.error}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-3 shrink-0 rounded-full text-warning hover:bg-warning/15 hover:text-warning"
                  onClick={() => void onDismissErrors(conversationId, turn.id)}
                >
                  <EyeOff className="size-3" />
                  忽略错误
                </Button>
              </div>
            ) : null}

            <div className="mt-3 flex items-center gap-1.5 text-[11px] sm:mt-4">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="rounded-full text-muted-foreground"
                onClick={() => void onRegenerateTurn(conversationId, turn.id)}
              >
                <RotateCcw className="size-3" />
                全部重新生成
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-6 rounded-full text-muted-foreground hover:text-destructive"
                onClick={() => onDeleteResults(conversationId, turn.id)}
                aria-label="删除生成结果"
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
});

type SuccessImageCardProps = {
  conversationId: string;
  image: StoredImage;
  index: number;
  onOpen: (imageId: string) => void;
  onContinueEdit: (conversationId: string, image: StoredImage | StoredReferenceImage) => void;
};

/** 已出图的结果卡片。图片对象不变就不会重渲染；自然尺寸是本卡片自己的状态，加载完成只刷新这一张。 */
const SuccessImageCard = memo(function SuccessImageCard({
  conversationId,
  image,
  index,
  onOpen,
  onContinueEdit,
}: SuccessImageCardProps) {
  const [dimensions, setDimensions] = useState(() => imageDimensions.get(image.id));
  const sizeLabel = image.b64_json ? formatBase64ImageSize(image.b64_json) : "";
  const imageMeta = [sizeLabel, dimensions].filter(Boolean).join(" · ");

  const handleLoad = useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>) => {
      const next = formatImageDimensions(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight);
      imageDimensions.set(image.id, next);
      setDimensions((current) => (current === next ? current : next));
    },
    [image.id],
  );
  const handleOpen = useCallback(() => onOpen(image.id), [onOpen, image.id]);

  return (
    <div className="break-inside-avoid">
      <LazyImage
        image={image}
        alt={`Generated result ${index + 1}`}
        className="group block aspect-square w-full cursor-zoom-in overflow-hidden rounded-2xl sm:aspect-auto"
        onLoad={handleLoad}
        onOpen={handleOpen}
      />
      <div className="flex flex-col gap-1 px-0.5 py-1 text-[10px] sm:gap-2.5 sm:px-1 sm:pt-2.5 sm:pb-1 sm:text-xs">
        <div className="min-w-0 text-muted-foreground">
          <div className="flex items-baseline gap-2">
            <span className="font-medium text-foreground/80 sm:text-[13px]">结果 {index + 1}</span>
            {image.durationMs != null ? <span>{formatDuration(image.durationMs)}</span> : null}
          </div>
          {imageMeta ? <div className="truncate">{imageMeta}</div> : null}
        </div>
        <div className="flex items-center gap-1.5 sm:grid sm:grid-cols-2 sm:gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="h-7 w-7 rounded-full px-0 sm:h-8 sm:w-full sm:px-3"
            onClick={() => onContinueEdit(conversationId, image)}
            aria-label="加入编辑"
          >
            <Sparkles className="size-3 sm:size-4" />
            <span className="hidden sm:inline">加入编辑</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="h-7 w-7 rounded-full px-0 sm:h-8 sm:w-full sm:px-3"
            onClick={() => void downloadStoredImage(image, index)}
            aria-label="下载"
          >
            <Download className="size-3 sm:size-4" />
            <span className="hidden sm:inline">下载</span>
          </Button>
        </div>
      </div>
    </div>
  );
});

function getTurnStatusLabel(status: ImageTurnStatus) {
  if (status === "queued") {
    return "排队中";
  }
  if (status === "generating") {
    return "处理中";
  }
  if (status === "success") {
    return "已完成";
  }
  return "失败";
}

const PROGRESS_LABELS: Record<string, string> = {
  getting_account: "确认可用账号",
  uploading: "上传图片",
  bootstrapping: "预热首页",
  getting_token: "获取 token",
  preparing_conversation: "准备会话",
  starting_generation: "启动生成",
  generating: "生成中",
  receiving_image: "接收图片中",
};

function getProgressLabel(progress?: string) {
  if (!progress) {
    return "生成中";
  }
  return PROGRESS_LABELS[progress] || "生成中";
}

function formatElapsed(seconds: number): string {
  return `${seconds.toFixed(1)}s`;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatBase64ImageSize(base64: string) {
  // 只靠长度和末尾的填充位估算字节数。不要对这个几 MB 的字符串做 replace / 拷贝，
  // 否则每张图第一次渲染都要白白分配一份同样大小的字符串。
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, Math.floor((base64.length * 3) / 4) - padding);

  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function formatImageDimensions(width: number, height: number) {
  return `${width} x ${height}`;
}

/**
 * 找到最近的可滚动祖先，作为 IntersectionObserver 的 root（这样 rootMargin 才会对滚动容器生效）。
 * 一轮可能有上百张图同时挂载：命中上一次找到的容器时只做一次 contains()，不再逐层 getComputedStyle（会强制样式重算）。
 */
let cachedScrollParent: HTMLElement | null = null;

function findScrollParent(element: HTMLElement | null): HTMLElement | null {
  if (element && cachedScrollParent?.isConnected && cachedScrollParent.contains(element)) {
    return cachedScrollParent;
  }
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") {
      cachedScrollParent = node;
      return node;
    }
  }
  return null;
}

/**
 * 进入可视区（含上下 400px 预加载区）才挂载 <img> 并解码 base64。
 * 以前不管图片在不在屏幕上，渲染会话时就会把其中每一张图同步解码一遍。
 */
function LazyImage({ image, alt, className, onLoad, onOpen }: {
  image: StoredImage;
  alt: string;
  className: string;
  onLoad?: (event: React.SyntheticEvent<HTMLImageElement>) => void;
  onOpen?: () => void;
}) {
  const [isVisible, setIsVisible] = useState(false);
  const holderRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = holderRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { root: findScrollParent(element), rootMargin: "400px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const src = isVisible ? getStoredImageSrc(image) : "";

  return (
    <div ref={holderRef} className="relative">
      {src ? (
        <button
          type="button"
          onClick={onOpen}
          className={className}
        >
          <img
            src={src}
            alt={alt}
            decoding="async"
            className="block h-full w-full object-cover transition duration-200 group-hover:brightness-90 sm:h-auto sm:object-contain"
            onLoad={onLoad}
          />
        </button>
      ) : (
        <div className={`animate-pulse rounded-2xl border border-border bg-muted min-h-[200px] sm:min-h-[280px] ${className}`} />
      )}
    </div>
  );
}
