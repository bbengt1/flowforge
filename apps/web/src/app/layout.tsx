import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlowForge",
  description: "FlowForge workflow platform",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full antialiased">
        <div className="flex min-h-full flex-col">
          <SiteHeader />
          <div className="flex-1">{children}</div>
        </div>
      </body>
    </html>
  );
}
