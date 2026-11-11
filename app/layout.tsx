import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mini Chat",
  description: "A research assistant that remembers past conversations and checks the live web.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
