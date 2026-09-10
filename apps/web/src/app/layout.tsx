import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { WorkspaceShell } from "@/components/shell/WorkspaceShell";
import { getPublicSwaggerUrl } from "@/lib/config";
import {
  EMBED_MOUNT_HEADER,
  EMBED_REJECTED_ASSERTION_HEADER,
  readConfiguredHostIssuers,
} from "@/lib/embed-contract";
import { SESSION_COOKIE_NAME } from "@/lib/session-contract";
import "./globals.css";

export const metadata: Metadata = {
  title: "FlowForge",
  description: "FlowForge workflow platform",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const headerList = await headers();
  const cookieStore = await cookies();
  const hostIssuers = readConfiguredHostIssuers({
    PORTAL_ISSUER: process.env.PORTAL_ISSUER,
    EMBED_ISSUER: process.env.EMBED_ISSUER,
    WEB_PORTAL_FRAME_ANCESTORS: process.env.WEB_PORTAL_FRAME_ANCESTORS,
    NEXT_PUBLIC_PORTAL_ISSUER: process.env.NEXT_PUBLIC_PORTAL_ISSUER,
    NEXT_PUBLIC_EMBED_ISSUER: process.env.NEXT_PUBLIC_EMBED_ISSUER,
  });
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full antialiased">
        <WorkspaceShell
          swaggerUrl={getPublicSwaggerUrl()}
          embedMount={headerList.get(EMBED_MOUNT_HEADER) === "1"}
          rejectedAssertion={
            headerList.get(EMBED_REJECTED_ASSERTION_HEADER) === "1"
          }
          hasSessionCookie={cookieStore.has(SESSION_COOKIE_NAME)}
          portalIssuer={hostIssuers.portalIssuer}
          embedIssuer={hostIssuers.embedIssuer}
          portalReferrerAllowlist={hostIssuers.portalReferrerAllowlist}
        >
          {children}
        </WorkspaceShell>
      </body>
    </html>
  );
}
