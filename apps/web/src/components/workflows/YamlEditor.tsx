"use client";

import { useEffect, useId, useRef } from "react";
import { lineCount, offsetForLine } from "@/lib/workflow";
import { highlightYaml } from "@/lib/workflow-yaml-highlight";
import { readYamlWorkflowMeta } from "@/lib/workflow-yaml-nodes";

type YamlEditorProps = {
  value: string;
  onChange: (value: string) => void;
  focusLine?: number | null;
  focusColumn?: number | null;
  focusToken?: number;
  errorLines?: number[];
};

const TOKEN_CLASS: Record<string, string> = {
  comment: "text-fg italic",
  key: "text-fg",
  string: "text-fg",
  number: "ff-yaml-number",
  boolean: "ff-yaml-boolean",
  punct: "text-fg",
  plain: "text-fg",
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
  const meta = readYamlWorkflowMeta(value);

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
    <div className="overflow-hidden rounded-xl border border-border bg-bg">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <label htmlFor={textareaId} className="text-sm font-medium text-fg">
          YAML
          {meta.name ? (
            <span className="ml-2 font-mono text-xs font-normal text-fg">
              {meta.name}
            </span>
          ) : null}
        </label>
        <p className="text-xs text-fg">
          Synced with the canvas. Line/column errors jump here.
        </p>
      </div>
      <div className="flex min-h-[22rem] max-h-[32rem]">
        <pre
          ref={gutterRef}
          aria-hidden
          className="min-w-12 shrink-0 overflow-hidden border-r border-border bg-bg px-2 py-3 text-right font-mono text-xs leading-6 text-fg"
        >
          {Array.from({ length: lines }, (_, index) => {
            const line = index + 1;
            return (
              <span
                key={line}
                className={errorSet.has(line) ? "block text-fg" : "block"}
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
            className="relative min-h-[22rem] w-full resize-y overflow-auto bg-transparent px-3 py-3 font-mono text-xs leading-6 text-transparent caret-fg outline-none"
          />
        </div>
      </div>
    </div>
  );
}
