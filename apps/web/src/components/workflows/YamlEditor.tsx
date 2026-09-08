"use client";

import { useEffect, useId, useRef } from "react";
import { lineCount, offsetForLine } from "@/lib/workflow";

type YamlEditorProps = {
  value: string;
  onChange: (value: string) => void;
  focusLine?: number | null;
  focusToken?: number;
  errorLines?: number[];
};

export function YamlEditor({
  value,
  onChange,
  focusLine,
  focusToken = 0,
  errorLines = [],
}: YamlEditorProps) {
  const textareaId = useId();
  const gutterRef = useRef<HTMLPreElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lines = lineCount(value);
  const errorSet = new Set(errorLines.filter((line) => line > 0));

  useEffect(() => {
    if (!focusLine || focusLine < 1) {
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const start = offsetForLine(value, focusLine);
    const lineText = value.split("\n")[focusLine - 1] ?? "";
    textarea.focus();
    textarea.setSelectionRange(start, start + lineText.length);
    const lineHeight = Number.parseFloat(
      window.getComputedStyle(textarea).lineHeight,
    );
    if (Number.isFinite(lineHeight) && lineHeight > 0) {
      textarea.scrollTop = Math.max(0, (focusLine - 3) * lineHeight);
      if (gutterRef.current) {
        gutterRef.current.scrollTop = textarea.scrollTop;
      }
    }
  }, [focusLine, focusToken, value]);

  function syncScroll() {
    const textarea = textareaRef.current;
    if (textarea && gutterRef.current) {
      gutterRef.current.scrollTop = textarea.scrollTop;
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-300 bg-white">
      <label htmlFor={textareaId} className="sr-only">
        Workflow YAML
      </label>
      <div className="flex min-h-[28rem] max-h-[40rem]">
        <pre
          ref={gutterRef}
          aria-hidden
          className="min-w-12 shrink-0 overflow-hidden border-r border-zinc-200 bg-zinc-50 px-2 py-3 text-right font-mono text-xs leading-6 text-zinc-400"
        >
          {Array.from({ length: lines }, (_, index) => {
            const line = index + 1;
            return (
              <span
                key={line}
                className={
                  errorSet.has(line)
                    ? "block text-amber-800"
                    : "block"
                }
              >
                {line}
              </span>
            );
          })}
        </pre>
        <textarea
          ref={textareaRef}
          id={textareaId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onScroll={syncScroll}
          spellCheck={false}
          wrap="off"
          className="min-h-[28rem] w-full resize-y overflow-auto bg-white px-3 py-3 font-mono text-xs leading-6 text-zinc-900 outline-none"
        />
      </div>
    </div>
  );
}
