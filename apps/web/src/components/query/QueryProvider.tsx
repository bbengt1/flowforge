"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { bindMfaStatusCache } from "@/lib/mfa-status-cache";
import { createFlowforgeQueryClient } from "@/lib/query-cache";

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => createFlowforgeQueryClient());
  useEffect(() => bindMfaStatusCache(client), [client]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
