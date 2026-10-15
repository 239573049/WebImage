"use client";

import { useState } from "react";
import { ImagePlus, LoaderCircle, Send, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { httpRequest } from "@/lib/request";
import { cn } from "@/lib/utils";

import { pretty, type ChatCompletionResponse, type ChatContentPart, type ChatMessage } from "./types";

type SelectedImage = {
  id: string;
  name: string;
  size: number;
  url: string;
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function readImage(file: File): Promise<SelectedImage> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error(`${file.name} 不是图片文件`));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error(`${file.name} 超过 10MB`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || "");
      if (!url.startsWith("data:image/")) {
        reject(new Error(`${file.name} 读取失败`));
        return;
      }
      resolve({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(16).slice(2)}`,
        name: file.name,
        size: file.size,
        url,
      });
    };
    reader.onerror = () => reject(reader.error || new Error(`${file.name} 读取失败`));
    reader.readAsDataURL(file);
  });
}

function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function messageImages(message: ChatMessage): string[] {
  if (!Array.isArray(message.content)) {
    return [];
  }
  return message.content
    .filter((part): part is { type: "image_url"; image_url: { url: string } } => part.type === "image_url")
    .map((part) => part.image_url.url);
}

export function ChatPanel() {
  const [model, setModel] = useState("auto");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [input, setInput] = useState("你好，先记住我的项目叫 chatgpt2api。");
  const [selectedImages, setSelectedImages] = useState<SelectedImage[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [raw, setRaw] = useState<ChatCompletionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleImagesChange = async (files: FileList | null) => {
    if (!files?.length) return;
    setError("");
    try {
      const images = await Promise.all(Array.from(files).map(readImage));
      setSelectedImages((current) => [...current, ...images].slice(0, 4));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const sendChat = async () => {
    const text = input.trim();
    if (!text && !selectedImages.length) return;
    const content: string | ChatContentPart[] = selectedImages.length
      ? [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...selectedImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.url } })),
        ]
      : text;
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(nextMessages);
    setInput("");
    setSelectedImages([]);
    setLoading(true);
    setError("");
    try {
      const body = {
        model: model.trim() || "auto",
        messages: nextMessages,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      };
      const result = await httpRequest<ChatCompletionResponse>("/v1/chat/completions", { method: "POST", body });
      setRaw(result);
      setMessages([...nextMessages, { role: "assistant", content: String(result.choices?.[0]?.message?.content || "") }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const clearChat = () => {
    setMessages([]);
    setSelectedImages([]);
    setRaw(null);
    setError("");
  };

  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <section className="surface flex min-h-0 flex-col rounded-2xl p-5">
        <div className="border-b border-border pb-3">
          <h2 className="text-sm font-medium text-muted-foreground">请求</h2>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto pt-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
            <div className="space-y-2">
              <Label htmlFor="chat-model">Model</Label>
              <Input id="chat-model" value={model} onChange={(event) => setModel(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="chat-reasoning-effort">思考强度</Label>
              <Select value={reasoningEffort || "default"} onValueChange={(value) => setReasoningEffort(value === "default" ? "" : value)}>
                <SelectTrigger id="chat-reasoning-effort">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">默认</SelectItem>
                  <SelectItem value="low">低</SelectItem>
                  <SelectItem value="medium">中</SelectItem>
                  <SelectItem value="high">高</SelectItem>
                  <SelectItem value="xhigh">超高</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="chat-input">Message</Label>
            <Textarea id="chat-input" value={input} onChange={(event) => setInput(event.target.value)} className="min-h-32" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="chat-images">图片</Label>
            <label htmlFor="chat-images" className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-field px-3 py-3 text-sm text-foreground/80 transition-colors hover:border-input hover:bg-field-hover">
              <ImagePlus className="size-4" />
              选择图片
            </label>
            <input id="chat-images" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="sr-only" onChange={(event) => {
              void handleImagesChange(event.target.files);
              event.currentTarget.value = "";
            }} />
            {selectedImages.length ? (
              <div className="grid grid-cols-2 gap-2">
                {selectedImages.map((image) => (
                  <div key={image.id} className="group relative overflow-hidden rounded-xl border border-border bg-muted">
                    <img src={image.url} alt={image.name} className="aspect-square w-full object-cover" />
                    <button type="button" aria-label={`移除 ${image.name}`} onClick={() => setSelectedImages((current) => current.filter((item) => item.id !== image.id))} className="absolute top-1 right-1 flex size-7 items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70">
                      <X className="size-4" />
                    </button>
                    <div className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-2 py-1 text-xs text-white">{image.name}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void sendChat()} disabled={loading || (!input.trim() && !selectedImages.length)}>
              {loading ? <LoaderCircle className="animate-spin" /> : <Send />}
              发送
            </Button>
            <Button size="sm" variant="outline" onClick={clearChat}>
              清空
            </Button>
          </div>
          {error ? <div className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div> : null}
          <Textarea value={raw ? pretty(raw) : "{\n  \"messages\": []\n}"} readOnly className="min-h-72 resize-none rounded-xl border border-border bg-field p-4 font-mono text-xs leading-5" />
        </div>
      </section>
      <section className="surface flex min-h-0 flex-col rounded-2xl p-5">
        <div className="border-b border-border pb-3">
          <h2 className="text-sm font-medium text-muted-foreground">对话</h2>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto pt-4">
          {messages.length ? messages.map((message, index) => (
            <div key={`${message.role}-${index}`} className="space-y-1.5 text-sm">
              <div className={cn("text-xs font-medium", message.role === "user" ? "text-foreground/70" : message.role === "assistant" ? "text-primary" : "text-muted-foreground")}>{message.role}</div>
              {messageImages(message).length ? (
                <div className="flex flex-wrap gap-2">
                  {messageImages(message).map((url, imageIndex) => (
                    <img key={`${index}-${imageIndex}`} src={url} alt="" className="h-28 w-28 rounded-xl border border-border object-cover" />
                  ))}
                </div>
              ) : null}
              {messageText(message) ? <div className="whitespace-pre-wrap leading-7 text-foreground/85">{messageText(message)}</div> : null}
            </div>
          )) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">暂无对话消息</div>
          )}
        </div>
      </section>
    </div>
  );
}
