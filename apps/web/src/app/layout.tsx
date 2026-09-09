import type { Metadata } from "next";
import { WorkspaceShell } from "@/components/shell/WorkspaceShell";
import { getPublicSwaggerUrl } from "@/lib/config";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlowForge",
  description: "FlowForge workflow platform",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full antialiased">
        <WorkspaceShell swaggerUrl={getPublicSwaggerUrl()}>
          {children}
        </WorkspaceShell>
      </body>
    </html>
  );
}
