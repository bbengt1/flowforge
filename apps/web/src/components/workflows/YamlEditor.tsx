"use client";

import { useEffect, useId, useRef } from "react";
import { lineCount, offsetForLine } from "@/lib/workflow";
import { highlightYaml } from "@/lib/workflow-yaml-highlight";

type YamlEditorProps = {
  value: string;
  onChange: (value: string) => void;
  focusLine?: number | null;
  focusColumn?: number | null;
  focusToken?: number;
  errorLines?: number[];
};

const TOKEN_CLASS: Record<string, string> = {
  comment: "text-zinc-400 italic",
  key: "text-teal-900",
  string: "text-amber-900",
  number: "text-sky-900",
  boolean: "text-violet-900",
  punct: "text-zinc-500",
  plain: "text-zinc-900",
};

export function YamlEditor({
  value,
  onChange,
  focusLine,
  focusColumn,
  focusToken = 0,
  errorLines = [],
}: YamlEditorProps) {
  const textareaId = useId();
  const gutterRef = useRef<HTMLPreElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lines = lineCount(value);
  const errorSet = new Set(errorLines.filter((line) => line > 0));
  const highlighted = highlightYaml(value);

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
    const column = focusColumn && focusColumn > 0 ? focusColumn - 1 : 0;
    textarea.focus();
    textarea.setSelectionRange(start + column, start + lineText.length);
    const lineHeight = Number.parseFloat(
      window.getComputedStyle(textarea).lineHeight,
    );
    if (Number.isFinite(lineHeight) && lineHeight > 0) {
      textarea.scrollTop = Math.max(0, (focusLine - 3) * lineHeight);
      syncScroll();
    }
  }, [focusColumn, focusLine, focusToken, value]);

  function syncScroll() {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    if (gutterRef.current) {
      gutterRef.current.scrollTop = textarea.scrollTop;
    }
    if (highlightRef.current) {
      highlightRef.current.scrollTop = textarea.scrollTop;
      highlightRef.current.scrollLeft = textarea.scrollLeft;
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-300 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2">
        <label htmlFor={textareaId} className="text-sm font-medium text-zinc-800">
          YAML
        </label>
        <p className="text-xs text-zinc-500">
          Synced with the canvas. Line/column errors jump here.
        </p>
      </div>
      <div className="flex min-h-[22rem] max-h-[32rem]">
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
                className={errorSet.has(line) ? "block text-amber-800" : "block"}
              >
                {line}
              </span>
            );
          })}
        </pre>
        <div className="relative min-h-[22rem] w-full">
          <pre
            ref={highlightRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden px-3 py-3 font-mono text-xs leading-6"
          >
            {highlighted.map((tokens, lineIndex) => (
              <span key={`hl-${lineIndex}`} className="block">
                {tokens.map((token, tokenIndex) => (
                  <span key={`${lineIndex}-${tokenIndex}`} className={TOKEN_CLASS[token.kind]}>
                    {token.text || " "}
                  </span>
                ))}
                {tokens.length === 0 ? " " : null}
              </span>
            ))}
          </pre>
          <textarea
            ref={textareaRef}
            id={textareaId}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onScroll={syncScroll}
            spellCheck={false}
            wrap="off"
            className="relative min-h-[22rem] w-full resize-y overflow-auto bg-transparent px-3 py-3 font-mono text-xs leading-6 text-transparent caret-zinc-900 outline-none"
          />
        </div>
      </div>
    </div>
  );
}
