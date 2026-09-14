import type { Metadata } from "next";
import { Inter, Noto_Sans_SC } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const chinese = Noto_Sans_SC({
  variable: "--font-chinese",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "bifurcation", template: "%s · bifurcation" },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-CN"
      data-mode="light"
      // Browser extensions such as Immersive Translate add attributes before hydration.
      suppressHydrationWarning
      className={`${inter.variable} ${chinese.variable} h-full antialiased`}
    >
      <body>{children}</body>
    </html>
  );
}
