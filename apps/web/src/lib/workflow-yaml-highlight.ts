/** Lightweight YAML highlighter for the editor overlay. No extra packages. */

export type YamlHighlightKind =
  | "plain"
  | "comment"
  | "key"
  | "string"
  | "number"
  | "boolean"
  | "punct";

export type YamlHighlightToken = {
  text: string;
  kind: YamlHighlightKind;
};

export function highlightYamlLine(line: string): YamlHighlightToken[] {
  const trimmedStart = line.match(/^\s*/)?.[0] ?? "";
  const rest = line.slice(trimmedStart.length);
  if (!rest) {
    return [{ text: line, kind: "plain" }];
  }
  if (rest.startsWith("#")) {
    return [
      ...(trimmedStart ? [{ text: trimmedStart, kind: "plain" as const }] : []),
      { text: rest, kind: "comment" },
    ];
  }
  const tokens: YamlHighlightToken[] = [];
  if (trimmedStart) {
    tokens.push({ text: trimmedStart, kind: "plain" });
  }
  const list = rest.startsWith("- ") ? "- " : rest.startsWith("-") ? "-" : "";
  let body = rest;
  if (list) {
    tokens.push({ text: list, kind: "punct" });
    body = rest.slice(list.length);
  }
  const pair = /^([^:#]+):(.*)$/.exec(body);
  if (!pair) {
    tokens.push(...highlightScalar(body));
    return tokens;
  }
  tokens.push({ text: `${pair[1]}:`, kind: "key" });
  const value = pair[2] ?? "";
  if (value) {
    tokens.push(...highlightScalar(value));
  }
  return tokens;
}

function highlightScalar(raw: string): YamlHighlightToken[] {
  if (!raw) {
    return [];
  }
  const leading = raw.match(/^\s*/)?.[0] ?? "";
  const value = raw.slice(leading.length);
  const tokens: YamlHighlightToken[] = [];
  if (leading) {
    tokens.push({ text: leading, kind: "plain" });
  }
  if (!value) {
    return tokens;
  }
  if (value.startsWith("#")) {
    tokens.push({ text: value, kind: "comment" });
    return tokens;
  }
  const commentAt = unquotedCommentIndex(value);
  const scalar = commentAt >= 0 ? value.slice(0, commentAt) : value;
  const comment = commentAt >= 0 ? value.slice(commentAt) : "";
  tokens.push({ text: scalar, kind: scalarKind(scalar.trim()) });
  if (comment) {
    tokens.push({ text: comment, kind: "comment" });
  }
  return tokens;
}

function unquotedCommentIndex(value: string): number {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== "\\") {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#") {
      return index;
    }
  }
  return -1;
}

function scalarKind(value: string): YamlHighlightKind {
  if (!value) {
    return "plain";
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return "string";
  }
  if (value === "true" || value === "false" || value === "null" || value === "~") {
    return "boolean";
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return "number";
  }
  return "plain";
}

export function highlightYaml(yaml: string): YamlHighlightToken[][] {
  return yaml.split("\n").map((line) => highlightYamlLine(line));
}
