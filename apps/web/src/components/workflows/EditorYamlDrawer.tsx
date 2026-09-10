"use client";

import type { ReactNode } from "react";

type EditorYamlDrawerProps = {
  open: boolean;
  tools?: ReactNode;
  children: ReactNode;
};

export function EditorYamlDrawer({
  open,
  tools,
  children,
}: EditorYamlDrawerProps) {
  if (!open) {
    return null;
  }

  return (
    <section
      id="editor-yaml-drawer"
      aria-label="YAML editor"
      className="flex max-h-[42%] min-h-[12rem] shrink-0 flex-col overflow-hidden border-t border-zinc-200 bg-white"
    >
      {tools ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-2">
          {tools}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
    </section>
  );
}
