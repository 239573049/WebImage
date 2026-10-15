"use client";
import { ArrowUp, ChevronDown, ImagePlus, Info, LoaderCircle, RectangleHorizontal, RectangleVertical, Square, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type RefObject } from "react";

import { ImageLightbox } from "@/components/image-lightbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ImageModel } from "@/lib/api";
import { cn } from "@/lib/utils";

type ImageComposerProps = {
  prompt: string;
  imageCount: string;
  imageRatio: string;
  imageTier: string;
  imageWidth: string;
  imageHeight: string;
  imageQuality: string;
  imageModel: ImageModel;
  imageModels: ImageModel[];
  availableQuota: string;
  activeTaskCount: number;
  referenceImages: Array<{ name: string; dataUrl: string }>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onPromptChange: (value: string) => void;
  onImageCountChange: (value: string) => void;
  onImageRatioChange: (value: string) => void;
  onImageTierChange: (value: string) => void;
  onImageWidthChange: (value: string) => void;
  onImageHeightChange: (value: string) => void;
  onImageQualityChange: (value: string) => void;
  onImageModelChange: (value: ImageModel) => void;
  onSubmit: () => void | Promise<void>;
  onPickReferenceImage: () => void;
  onReferenceImageChange: (files: File[]) => void | Promise<void>;
  onRemoveReferenceImage: (index: number) => void;
};

const imageFileNamePattern = /\.(avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/i;

function isImageFile(file: File) {
  return file.type.startsWith("image/") || (!file.type && imageFileNamePattern.test(file.name));
}

function hasDraggedImages(dataTransfer: DataTransfer) {
  const items = Array.from(dataTransfer.items || []);
  if (items.length > 0) {
    return items.some((item) => item.kind === "file" && (item.type.startsWith("image/") || !item.type));
  }
  return Array.from(dataTransfer.files || []).some(isImageFile);
}

function getDraggedImageFiles(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.files || []).filter(isImageFile);
}

const qualityOptions = [
  { value: "auto", label: "自动" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
];
const aspectOptions = [
  { ratio: "1:1", tier: "1k", width: "1024", height: "1024", label: "1:1", icon: Square },
  { ratio: "2:3", tier: "1k", width: "1024", height: "1536", label: "2:3", icon: RectangleVertical },
  { ratio: "3:2", tier: "1k", width: "1536", height: "1024", label: "3:2", icon: RectangleHorizontal },
  { ratio: "3:4", tier: "1k", width: "1024", height: "1365", label: "3:4", icon: RectangleVertical },
  { ratio: "4:3", tier: "1k", width: "1365", height: "1024", label: "4:3", icon: RectangleHorizontal },
  { ratio: "9:16", tier: "1k", width: "1088", height: "1920", label: "9:16", icon: RectangleVertical },
  { ratio: "16:9", tier: "1k", width: "1920", height: "1088", label: "16:9", icon: RectangleHorizontal },
  { ratio: "1:1", tier: "2k", width: "2048", height: "2048", label: "1:1(2k)", icon: Square },
  { ratio: "16:9", tier: "2k", width: "2560", height: "1440", label: "16:9(2k)", icon: RectangleHorizontal },
  { ratio: "9:16", tier: "2k", width: "1440", height: "2560", label: "9:16(2k)", icon: RectangleVertical },
  { ratio: "16:9", tier: "4k", width: "3840", height: "2160", label: "16:9(4k)", icon: RectangleHorizontal },
  { ratio: "9:16", tier: "4k", width: "2160", height: "3840", label: "9:16(4k)", icon: RectangleVertical },
  { ratio: "auto", tier: "auto", width: "1024", height: "1024", label: "auto", icon: null },
];
const countOptions = Array.from({ length: 10 }, (_, index) => String(index + 1));

// memo：生成轮询、会话切换等与输入区无关的状态变化不应该带着它重渲染
export const ImageComposer = memo(function ImageComposer({
  prompt,
  imageCount,
  imageRatio,
  imageTier,
  imageWidth,
  imageHeight,
  imageQuality,
  imageModel,
  imageModels,
  availableQuota,
  activeTaskCount,
  referenceImages,
  textareaRef,
  fileInputRef,
  onPromptChange,
  onImageCountChange,
  onImageRatioChange,
  onImageTierChange,
  onImageWidthChange,
  onImageHeightChange,
  onImageQualityChange,
  onImageModelChange,
  onSubmit,
  onPickReferenceImage,
  onReferenceImageChange,
  onRemoveReferenceImage,
}: ImageComposerProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [isSizeMenuOpen, setIsSizeMenuOpen] = useState(false);
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const [sizeMenuPos, setSizeMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const sizeMenuRef = useRef<HTMLDivElement>(null);
  const sizeMenuBtnRef = useRef<HTMLButtonElement>(null);
  const lightboxImages = useMemo(
    () => referenceImages.map((image, index) => ({ id: `${image.name}-${index}`, src: image.dataUrl })),
    [referenceImages],
  );
  const modelOptions = useMemo(
    () => imageModels.map((model) => ({ value: model, label: model })),
    [imageModels],
  );
  const qualityLabel = qualityOptions.find((option) => option.value === imageQuality)?.label || "自动";
  const ratioLabel = imageRatio === "auto" ? "auto" : `${imageRatio}(${imageTier})`;
  const imageSizeLabel = `${qualityLabel} · ${ratioLabel} · ${imageCount || 1} 张`;
  const selectedModelLabel = modelOptions.find((option) => option.value === imageModel)?.label || imageModel;
  const isCodexModel = imageModel.toLowerCase().includes("codex");

  useEffect(() => {
    if (!isSizeMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-slot="select-content"], [data-slot="select-trigger"]')
      ) {
        return;
      }
      if (!sizeMenuRef.current?.contains(target as Node)) {
        setIsSizeMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isSizeMenuOpen]);

  const handleTextareaPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    void onReferenceImageChange(imageFiles);
  };

  const handleComposerDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedImages(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsSizeMenuOpen(false);
    setIsDraggingImage(true);
  };

  const handleComposerDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedImages(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDraggingImage(true);
  };

  const handleComposerDragLeave = (event: DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    setIsDraggingImage(false);
  };

  const handleComposerDrop = (event: DragEvent<HTMLDivElement>) => {
    const imageFiles = getDraggedImageFiles(event.dataTransfer);
    if (event.dataTransfer.files.length > 0 || imageFiles.length > 0) {
      event.preventDefault();
      event.stopPropagation();
    }

    setIsDraggingImage(false);
    if (imageFiles.length === 0) {
      return;
    }

    void onReferenceImageChange(imageFiles);
  };

  return (
    <div className="shrink-0 flex justify-center px-1 sm:px-0">
      <div style={{ width: "min(980px, 100%)" }}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            void onReferenceImageChange(Array.from(event.target.files || []));
          }}
        />

        {referenceImages.length > 0 ? (
          <div className="mb-2 flex gap-2 overflow-x-auto px-1 pb-1 sm:mb-3 sm:flex-wrap sm:overflow-visible sm:pb-0">
            {referenceImages.map((image, index) => (
              <div key={`${image.name}-${index}`} className="relative size-14 shrink-0 sm:size-16">
                <button
                  type="button"
                  onClick={() => {
                    setLightboxIndex(index);
                    setLightboxOpen(true);
                  }}
                  className="group size-14 overflow-hidden rounded-2xl border border-border bg-muted transition-colors hover:border-border sm:size-16"
                  aria-label={`预览参考图 ${image.name || index + 1}`}
                >
                  <img
                    src={image.dataUrl}
                    alt={image.name || `参考图 ${index + 1}`}
                    className="h-full w-full object-cover"
                  />
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemoveReferenceImage(index);
                  }}
                  className="absolute -right-1 -top-1 inline-flex size-5 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-4 focus-visible:ring-ring/40"
                  aria-label={`移除参考图 ${image.name || index + 1}`}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div
          className={cn(
            "surface-raised overflow-hidden rounded-[22px] transition-colors focus-within:border-primary/40",
            isDraggingImage && "border-primary",
          )}
        >
          <div
            className="relative cursor-text"
            onDragEnter={handleComposerDragEnter}
            onDragOver={handleComposerDragOver}
            onDragLeave={handleComposerDragLeave}
            onDrop={handleComposerDrop}
            onClick={() => {
              textareaRef.current?.focus();
            }}
          >
            <ImageLightbox
              images={lightboxImages}
              currentIndex={lightboxIndex}
              open={lightboxOpen}
              onOpenChange={setLightboxOpen}
              onIndexChange={setLightboxIndex}
            />
            <Textarea
              ref={textareaRef}
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              onPaste={handleTextareaPaste}
              placeholder={
                referenceImages.length > 0
                  ? "描述你希望如何修改参考图"
                  : "输入你想要生成的画面，也可直接粘贴图片"
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void onSubmit();
                }
              }}
              className="min-h-[82px] resize-none rounded-[22px] border-0 bg-transparent px-4 pt-4 pb-2 text-[15px] leading-6 text-foreground shadow-none placeholder:text-muted-foreground/70 hover:bg-transparent focus-visible:ring-0 sm:min-h-[148px] sm:px-6 sm:pt-6 sm:pb-20 sm:leading-7"
            />
            {isDraggingImage ? (
              <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[22px] border-2 border-dashed border-primary bg-primary/10 text-sm font-medium text-primary">
                <div className="flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-white">
                  <ImagePlus className="size-4" />
                  <span>松开以上传参考图</span>
                </div>
              </div>
            ) : null}

            <div className="rounded-b-[24px] border-t border-border bg-card px-3 pb-3 pt-2 sm:absolute sm:inset-x-0 sm:bottom-0 sm:rounded-b-none sm:border-t-0 sm:bg-transparent sm:px-6 sm:pb-4 sm:pt-6" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-end justify-between gap-2 sm:gap-3">
                <div className="hide-scrollbar flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5 sm:flex-wrap sm:gap-3 sm:overflow-visible sm:pb-0">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-9 shrink-0 rounded-full px-3 sm:h-10 sm:px-4"
                    onClick={onPickReferenceImage}
                    aria-label={referenceImages.length > 0 ? "添加参考图" : "上传"}
                  >
                    <ImagePlus className="size-3.5 sm:size-4" />
                    <span className="hidden sm:inline">{referenceImages.length > 0 ? "添加参考图" : "上传"}</span>
                  </Button>
                  <Badge variant="secondary" className="shrink-0 px-2 py-1 text-[10px] sm:px-3 sm:py-2 sm:text-xs">
                    <span className="hidden sm:inline">剩余额度 </span>{availableQuota}
                  </Badge>
                  {activeTaskCount > 0 && (
                    <Badge variant="warning" className="shrink-0 gap-1 px-2 py-1 text-[10px] sm:gap-1.5 sm:px-3 sm:py-2 sm:text-xs">
                      <LoaderCircle className="size-3 animate-spin" />
                      {activeTaskCount}<span className="hidden sm:inline"> 个任务处理中</span>
                    </Badge>
                  )}
                  <div className="relative flex h-9 min-w-0 shrink items-center rounded-full bg-transparent text-[11px] sm:h-auto sm:shrink-0 sm:text-[13px]">
                    <button
                      ref={sizeMenuBtnRef}
                      type="button"
                      className="inline-flex h-9 w-fit max-w-[calc(100vw-12rem)] items-center justify-between gap-2 rounded-full bg-secondary px-4 text-left text-xs font-semibold text-secondary-foreground transition-colors hover:bg-secondary/70 sm:h-10 sm:max-w-none sm:text-sm"
                      onClick={() => {
                        if (!isSizeMenuOpen && sizeMenuBtnRef.current) {
                          const rect = sizeMenuBtnRef.current.getBoundingClientRect();
                          const menuWidth = Math.min(460, window.innerWidth - 32);
                          setSizeMenuPos({ top: rect.top - 8, left: Math.max(16, Math.min(rect.left, window.innerWidth - menuWidth - 16)) });
                        }
                        setIsSizeMenuOpen((open) => !open);
                      }}
                    >
                      <span className="truncate">{imageSizeLabel}</span>
                      <ChevronDown className={cn("size-4 shrink-0 opacity-60 transition-transform", isSizeMenuOpen && "rotate-180")} />
                    </button>
                    {isSizeMenuOpen ? (
                      <div
                        ref={sizeMenuRef}
                        className="fixed z-[80] max-h-[calc(100dvh-6.5rem)] overflow-y-auto rounded-2xl border border-border bg-popover p-4 shadow-overlay"
                        style={{
                          top: sizeMenuPos.top,
                          left: sizeMenuPos.left,
                          transform: "translateY(-100%)",
                          width: "min(460px, calc(100vw - 2rem))",
                        }}
                      >
                        <h3 className="mb-3 text-base font-semibold text-foreground">图像设置</h3>
                        <div className="mb-3">
                          <div className="mb-2 text-sm font-medium text-foreground">模型</div>
                          <Select
                            value={imageModel}
                            onValueChange={(value) => {
                              onImageModelChange(value as ImageModel);
                            }}
                          >
                            <SelectTrigger className="h-10">
                              <div className="flex min-w-0 items-center gap-2">
                                <img
                                  src="/openai.svg"
                                  alt=""
                                  aria-hidden="true"
                                  className="size-4 shrink-0"
                                />
                                <span className="truncate">{selectedModelLabel}</span>
                              </div>
                            </SelectTrigger>
                            <SelectContent className="z-[120]">
                              {modelOptions.map((option) => (
                                <SelectItem
                                  key={option.value}
                                  value={option.value}
                                  className="pl-10"
                                  style={{
                                    backgroundImage: "url('/openai.svg')",
                                    backgroundRepeat: "no-repeat",
                                    backgroundPosition: "12px center",
                                    backgroundSize: "16px 16px",
                                  }}
                                >
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="mb-3">
                          <div className="mb-2 text-sm font-medium text-foreground">质量</div>
                          <div className="grid grid-cols-4 gap-2">
                            {qualityOptions.map((option) => {
                              const active = option.value === imageQuality;
                              return (
                                <button
                                  key={option.value}
                                  type="button"
                                  className={cn(
                                    "h-9 cursor-pointer rounded-full border text-sm text-foreground transition-colors hover:bg-field-hover",
                                    active
                                      ? "border-primary bg-primary/10 text-foreground"
                                      : "border-border bg-field",
                                  )}
                                  onClick={() => onImageQualityChange(option.value)}
                                >
                                  {option.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        <div className="mb-3">
                          <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-foreground">
                            尺寸 <Info className="size-3.5 text-muted-foreground" />
                          </div>
                          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                            <div className="flex items-center gap-2">
                              <span className="text-sm text-muted-foreground">W</span>
                              <Input
                                type="number"
                                inputMode="numeric"
                                min="1"
                                value={imageWidth}
                                onChange={(event) => onImageWidthChange(event.target.value)}
                                className="h-9 px-2 text-sm font-medium"
                              />
                            </div>
                            <span className="text-muted-foreground">×</span>
                            <div className="flex items-center gap-2">
                              <span className="text-sm text-muted-foreground">H</span>
                              <Input
                                type="number"
                                inputMode="numeric"
                                min="1"
                                value={imageHeight}
                                onChange={(event) => onImageHeightChange(event.target.value)}
                                className="h-9 px-2 text-sm font-medium"
                              />
                            </div>
                          </div>
                        </div>
                        <div className="mb-3">
                          <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-foreground">
                            宽高比 <Info className="size-3.5 text-muted-foreground" />
                          </div>
                          <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                            {aspectOptions.map((option) => {
                              const active = option.ratio === imageRatio && option.tier === imageTier && option.width === imageWidth && option.height === imageHeight;
                              const Icon = option.icon;
                              const disabled = !isCodexModel && (option.tier === "2k" || option.tier === "4k");
                              return (
                                <button
                                  key={`${option.ratio}-${option.tier}-${option.label}`}
                                  type="button"
                                  disabled={disabled}
                                  className={cn(
                                    "flex h-[64px] cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl border text-sm text-foreground transition-colors hover:bg-field-hover",
                                    active
                                      ? "border-primary bg-primary/10 text-foreground"
                                      : "border-border bg-field",
                                    disabled && "cursor-not-allowed border-border bg-field opacity-45 hover:bg-field",
                                  )}
                                  onClick={() => {
                                    if (disabled) {
                                      return;
                                    }
                                    onImageRatioChange(option.ratio);
                                    onImageTierChange(option.tier);
                                    onImageWidthChange(option.width);
                                    onImageHeightChange(option.height);
                                  }}
                                >
                                  {Icon ? (
                                    <>
                                      <Icon className="size-3.5 stroke-[1.8]" />
                                      <span>{option.label}</span>
                                    </>
                                  ) : (
                                    <span>{option.label}</span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        <div className="border-t border-border pt-3">
                          <div className="mb-2 text-sm font-medium text-foreground">生成数量</div>
                          <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                            {countOptions.map((option) => {
                              const active = imageCount === option;
                              return (
                                <button
                                  key={option}
                                  type="button"
                                  className={cn(
                                    "h-9 cursor-pointer rounded-full border text-sm text-foreground transition-colors hover:bg-field-hover",
                                    active
                                      ? "border-primary bg-primary/10 text-foreground"
                                      : "border-border bg-field",
                                  )}
                                  onClick={() => onImageCountChange(option)}
                                >
                                  {option} 张
                                </button>
                              );
                            })}
                            <Input
                              type="number"
                              inputMode="numeric"
                              min="1"
                              max="100"
                              step="1"
                              value={imageCount}
                              onChange={(event) => onImageCountChange(event.target.value)}
                              className="h-9 px-3 text-center text-sm font-medium"
                            />
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>

                </div>

                <button
                  type="button"
                  onClick={() => void onSubmit()}
                  disabled={!prompt.trim()}
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-white outline-none transition-[background-color,color,transform] hover:bg-primary/90 active:scale-[0.98] focus-visible:ring-4 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:bg-secondary disabled:text-muted-foreground"
                  aria-label={referenceImages.length > 0 ? "编辑图片" : "生成图片"}
                >
                  <ArrowUp className="size-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
