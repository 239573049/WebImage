import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "@/components/shell/app-shell";
import { ThemeScript } from "@/components/theme-script";
import { ThemedToaster } from "@/components/themed-toaster";

export const metadata: Metadata = {
  title: "WebImage 控制台",
  description: "ChatGPT account pool management console",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#161617" },
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
      <body className="h-dvh overflow-hidden text-foreground antialiased">
        <ThemedToaster />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
