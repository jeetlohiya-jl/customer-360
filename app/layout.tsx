import type { Metadata } from "next";
import { headers } from "next/headers";
import "@fontsource-variable/fraunces/opsz.css";
import "@fontsource-variable/fraunces/opsz-italic.css";
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Customer 360 · Cirkla",
  description: "Cirkla internal customer intelligence",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Reading request headers makes every page dynamically rendered, which the
  // per-request CSP nonce requires. Next.js applies the nonce automatically.
  await headers();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
