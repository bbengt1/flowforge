/**
 * In-app notifications for validation, publish, and execution
 * status. Payloads are sanitized — secrets and redacted leaves
 * are never stored or shown.
 */

import { isSecretFieldName, stripSecretFields } from "./credential.ts";

export const NOTIFICATION_KINDS = [
  "validation",
  "publish",
  "execution",
  "info",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type WorkspaceNotification = {
  id: string;
  kind: NotificationKind;
  title: string;
  detail: string;
  href?: string;
  createdAt: string;
};

function readSafeText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === "[redacted]") {
    return "";
  }
  return trimmed.slice(0, 240);
}

export function sanitizeNotification(
  input: {
    id?: string;
    kind?: string;
    title?: unknown;
    detail?: unknown;
    href?: unknown;
    createdAt?: string;
    [key: string]: unknown;
  },
): WorkspaceNotification | null {
  const stripped = stripSecretFields(input);
  const body = stripped.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const raw = body as Record<string, unknown>;
  const kind = NOTIFICATION_KINDS.includes(raw.kind as NotificationKind)
    ? (raw.kind as NotificationKind)
    : "info";
  const title = readSafeText(raw.title);
  if (!title) {
    return null;
  }
  for (const key of Object.keys(input)) {
    if (isSecretFieldName(key)) {
      continue;
    }
  }
  const href = readSafeText(raw.href);
  return {
    id:
      readSafeText(raw.id) ||
      `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    title,
    detail: readSafeText(raw.detail),
    ...(href ? { href } : {}),
    createdAt:
      typeof raw.createdAt === "string" && raw.createdAt
        ? raw.createdAt
        : new Date().toISOString(),
  };
}

let items: WorkspaceNotification[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export function getNotifications(): WorkspaceNotification[] {
  return items;
}

export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function pushNotification(
  input: Parameters<typeof sanitizeNotification>[0],
): WorkspaceNotification | null {
  const next = sanitizeNotification(input);
  if (!next) {
    return null;
  }
  items = [next, ...items].slice(0, 20);
  emit();
  return next;
}

export function clearNotifications(): void {
  items = [];
  emit();
}

export function dismissNotification(id: string): void {
  items = items.filter((item) => item.id !== id);
  emit();
}
