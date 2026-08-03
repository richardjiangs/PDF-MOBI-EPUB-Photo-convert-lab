import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);
  const title = "PageForge Local 2.1";
  const description = "One private offline upload box for PDF similarity and blank-page review, EPUB/MOBI/AZW3 conversion, and photo export.";
  return {
    metadataBase,
    title,
    description,
    icons: { icon: "/favicon.png", shortcut: "/favicon.png" },
    openGraph: { title, description, type: "website", images: [{ url: "/og.png", width: 1536, height: 1024, alt: "PageForge Local 2.1 one-box offline document converter" }] },
    twitter: { card: "summary_large_image", title, description, images: ["/og.png"] },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
