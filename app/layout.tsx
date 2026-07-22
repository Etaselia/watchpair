import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "WatchPair | Watch in sync";
const description =
  "Pair two browsers, prepare the same local video, and keep playback, subtitles, and language choices in sync.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const candidateHost =
    requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const host = /^[a-z0-9.:[\]-]+$/i.test(candidateHost) ? candidateHost : "localhost:3000";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol =
    forwardedProtocol === "https" || (!host.startsWith("localhost") && !host.startsWith("127.0.0.1"))
      ? "https"
      : "http";
  const origin = `${protocol}://${host}`;
  const image = `${origin}/og.png`;

  return {
    metadataBase: new URL(origin),
    title,
    description,
    openGraph: {
      title: "WatchPair",
      description: "Same frame. Same moment.",
      url: origin,
      siteName: "WatchPair",
      type: "website",
      images: [{ url: image, width: 1664, height: 936, alt: "WatchPair synchronized playback" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "WatchPair",
      description: "Same frame. Same moment.",
      images: [image],
    },
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
