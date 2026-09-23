/**
 * G.2.5 / #450 list chrome for jonny's keyset page (#471).
 *
 * Every paginated collection returns
 * `{items, limit, cursor, next}`. `items` is never null.
 * Walk pages with `cursor=<previous next>` and the same limit, q,
 * and filters. Stop when `next` is `""`.
 *
 * Query rules match the API: limit 1–100 (omit = server default 50),
 * opaque cursor, `q` case-insensitive substring max 200 runes.
 * Bad limit, cursor, or q is fail-closed with the static detail
 * `limit, cursor, or q is not valid.` — the token and q are never echoed.
 * Secrets never go in the query string, the address bar, or localStorage.
 */

import type { ProblemDetails } from "./problem.ts";
import { looksLikeSecretValue } from "./workflow-yaml-nodes.ts";

export const COLLECTION_PAGE_DEFAULT_LIMIT = 50;
export const COLLECTION_PAGE_MIN_LIMIT = 1;
export const COLLECTION_PAGE_MAX_LIMIT = 100;
export const COLLECTION_PAGE_MAX_Q_RUNES = 200;
export const COLLECTION_PAGE_MAX_CURSOR_CHARS = 2048;
export const COLLECTION_PAGE_INVALID_DETAIL =
  "limit, cursor, or q is not valid.";

export const COLLECTION_PAGE_QUERY_KEYS = ["limit", "cursor", "q"] as const;

/** Never copy these onto a list URL. */
export const COLLECTION_PAGE_SECRET_QUERY_KEYS = [
  "secret",
  "secrets",
  "token",
  "password",
  "passwd",
  "kubeconfig",
  "privateKey",
  "private_key",
  "passphrase",
  "plaintext",
  "authorization",
  "credential",
  "credentials",
  "kek",
  "dek",
  "apiKey",
  "api_key",
  "clientSecret",
  "client_secret",
] as const;

export type CollectionPage<T> = {
  items: T[];
  limit: number;
  cursor: string;
  next: string;
};

export type CollectionPageMeta = {
  limit: number;
  cursor: string;
  next: string;
};

export type CollectionPageQuery = {
  limit?: number;
  cursor?: string;
  q?: string;
};

const SECRET_QUERY_KEY_SET = new Set(
  COLLECTION_PAGE_SECRET_QUERY_KEYS.map((key) => key.toLowerCase()),
);

export function emptyCollectionPage<T>(
  limit = COLLECTION_PAGE_DEFAULT_LIMIT,
): CollectionPage<T> {
  return { items: [], limit, cursor: "", next: "" };
}

export function collectionPageHasNext(page: { next?: string | null }): boolean {
  return typeof page.next === "string" && page.next.trim().length > 0;
}

export function runeCount(value: string): number {
  return [...value].length;
}

export function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function isSecretQueryKey(key: string): boolean {
  return SECRET_QUERY_KEY_SET.has(key.trim().toLowerCase());
}

function readLimitField(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    if (value >= COLLECTION_PAGE_MIN_LIMIT && value <= COLLECTION_PAGE_MAX_LIMIT) {
      return value;
    }
  }
  return COLLECTION_PAGE_DEFAULT_LIMIT;
}

function readOpaqueField(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value;
}

export function readCollectionPageFields(raw: unknown): CollectionPageMeta {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      limit: COLLECTION_PAGE_DEFAULT_LIMIT,
      cursor: "",
      next: "",
    };
  }
  const body = raw as Record<string, unknown>;
  return {
    limit: readLimitField(body.limit),
    cursor: readOpaqueField(body.cursor),
    next: readOpaqueField(body.next),
  };
}

export function collectionItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const items = (raw as { items?: unknown }).items;
  return Array.isArray(items) ? items : [];
}

export function parseCollectionPage<T>(
  raw: unknown,
  parseItem: (item: unknown) => T | null,
): CollectionPage<T> {
  const items: T[] = [];
  for (const item of collectionItems(raw)) {
    const parsed = parseItem(item);
    if (parsed) {
      items.push(parsed);
    }
  }
  const meta = readCollectionPageFields(raw);
  return { items, ...meta };
}

export function appendCollectionItems<T extends { id: string }>(
  current: readonly T[],
  page: readonly T[],
): T[] {
  const seen = new Set(current.map((item) => item.id));
  const next = [...current];
  for (const item of page) {
    if (!item.id || seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    next.push(item);
  }
  return next;
}

/**
 * Validate limit / cursor / q before they touch the network.
 * Failure detail is the static contract string and does not include
 * the rejected value.
 */
export function validateCollectionPageQuery(
  input: CollectionPageQuery = {},
):
  | { ok: true; limit?: number; cursor: string; q: string }
  | { ok: false; detail: typeof COLLECTION_PAGE_INVALID_DETAIL } {
  let limit: number | undefined;
  if (input.limit !== undefined) {
    if (
      typeof input.limit !== "number" ||
      !Number.isInteger(input.limit) ||
      input.limit < COLLECTION_PAGE_MIN_LIMIT ||
      input.limit > COLLECTION_PAGE_MAX_LIMIT
    ) {
      return { ok: false, detail: COLLECTION_PAGE_INVALID_DETAIL };
    }
    limit = input.limit;
  }

  const cursor = (input.cursor ?? "").trim();
  if (cursor) {
    if (
      cursor.length > COLLECTION_PAGE_MAX_CURSOR_CHARS ||
      hasAsciiControl(cursor) ||
      looksLikeSecretValue(cursor)
    ) {
      return { ok: false, detail: COLLECTION_PAGE_INVALID_DETAIL };
    }
  }

  const q = (input.q ?? "").trim();
  if (q) {
    if (
      runeCount(q) > COLLECTION_PAGE_MAX_Q_RUNES ||
      hasAsciiControl(q) ||
      looksLikeSecretValue(q)
    ) {
      return { ok: false, detail: COLLECTION_PAGE_INVALID_DETAIL };
    }
  }

  return { ok: true, limit, cursor, q };
}

function stripUnsafeParams(params: URLSearchParams): void {
  const drop: string[] = [];
  for (const key of params.keys()) {
    if (isSecretQueryKey(key)) {
      drop.push(key);
    }
  }
  for (const key of drop) {
    params.delete(key);
  }
}

export function appendCollectionPageQuery(
  path: string,
  input: CollectionPageQuery = {},
):
  | { ok: true; path: string }
  | { ok: false; detail: typeof COLLECTION_PAGE_INVALID_DETAIL } {
  const validated = validateCollectionPageQuery(input);
  if (!validated.ok) {
    return validated;
  }
  const splitAt = path.indexOf("?");
  const pathname = splitAt === -1 ? path : path.slice(0, splitAt);
  const params = new URLSearchParams(splitAt === -1 ? "" : path.slice(splitAt + 1));
  stripUnsafeParams(params);
  if (validated.limit !== undefined) {
    params.set("limit", String(validated.limit));
  }
  if (validated.cursor) {
    params.set("cursor", validated.cursor);
  } else {
    params.delete("cursor");
  }
  if (validated.q) {
    params.set("q", validated.q);
  } else {
    params.delete("q");
  }
  const query = params.toString();
  return { ok: true, path: query ? `${pathname}?${query}` : pathname };
}

export function invalidCollectionPageProblem(instance: string): ProblemDetails {
  const pathOnly = instance.split("?")[0] || instance;
  return {
    type: "urn:flowforge:problem:invalid-request",
    title: "Invalid Request",
    status: 400,
    detail: COLLECTION_PAGE_INVALID_DETAIL,
    instance: pathOnly,
    code: "invalid-request",
    request_id: "",
  };
}

/** Drop cursor and q from a problem so a 400 cannot echo them. */
export function scrubCollectionPageProblem(problem: ProblemDetails): ProblemDetails {
  if (problem.status !== 400) {
    return problem;
  }
  return {
    ...problem,
    detail: COLLECTION_PAGE_INVALID_DETAIL,
    instance: stripCursorAndQuery(problem.instance),
  };
}

function stripCursorAndQuery(instance: string): string {
  const splitAt = instance.indexOf("?");
  if (splitAt === -1) {
    return instance;
  }
  const params = new URLSearchParams(instance.slice(splitAt + 1));
  params.delete("cursor");
  params.delete("q");
  stripUnsafeParams(params);
  const query = params.toString();
  const path = instance.slice(0, splitAt);
  return query ? `${path}?${query}` : path;
}

export function openCollectionPath(
  path: string,
  input: CollectionPageQuery = {},
):
  | { ok: true; path: string }
  | { ok: false; problem: ProblemDetails } {
  const opened = appendCollectionPageQuery(path, input);
  if (!opened.ok) {
    return { ok: false, problem: invalidCollectionPageProblem(path) };
  }
  return opened;
}
