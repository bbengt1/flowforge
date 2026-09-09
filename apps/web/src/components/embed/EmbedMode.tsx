"use client";

import { createContext, useContext, type ReactNode } from "react";

const EmbedModeContext = createContext(false);

export function EmbedModeProvider({
  embed,
  children,
}: {
  embed: boolean;
  children: ReactNode;
}) {
  return (
    <EmbedModeContext.Provider value={embed}>{children}</EmbedModeContext.Provider>
  );
}

/** True when the canonical UI is mounted under /embed/v1. */
export function useEmbedMode(): boolean {
  return useContext(EmbedModeContext);
}
