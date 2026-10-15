import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ThemeScript } from "@/components/theme-script";
import { ThemedToaster } from "@/components/themed-toaster";
import { SideNav } from "@/components/side-nav";

export const metadata: Metadata = {
  title: "ChatGPT 号池管理",
  description: "ChatGPT account pool management dashboard",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f4f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0b10" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-dvh overflow-hidden" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="h-dvh overflow-hidden antialiased">
        <ThemedToaster />
        <main className="flex h-dvh flex-col overflow-hidden text-foreground">
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <SideNav />
            {/* 外层负责留白，内层负责滚动；避免 padding + h-full 叠出多余滚动条 */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pt-[env(safe-area-inset-top)] sm:py-3 sm:pr-2">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto px-4 pb-4 pt-3 sm:px-4 sm:pt-1 [&>*]:min-h-0">
                {children}
              </div>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
