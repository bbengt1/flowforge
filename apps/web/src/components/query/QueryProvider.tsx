"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { createFlowforgeQueryClient } from "@/lib/query-cache";

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => createFlowforgeQueryClient());
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
