"use client";

import type { ReactNode } from "react";
import { SATELLITE_BODY_PAD_CLASS, SATELLITE_HEADER_CLASS } from "@/lib/aesthetic-usability-density";
import { EDITOR_YAML_PANEL_ID } from "@/lib/e12-accessibility-contract";

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
      id={EDITOR_YAML_PANEL_ID}
      aria-label="YAML editor"
      className="flex max-h-[42%] min-h-[12rem] shrink-0 flex-col overflow-hidden border-t border-zinc-200 bg-white"
    >
      {tools ? (
        <div className={`${SATELLITE_HEADER_CLASS} shrink-0 flex-wrap gap-2`}>
          {tools}
        </div>
      ) : null}
      <div className={`min-h-0 flex-1 overflow-auto ${SATELLITE_BODY_PAD_CLASS}`}>{children}</div>
    </section>
  );
}
