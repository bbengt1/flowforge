"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import {
  dismissNotification,
  getNotifications,
  subscribeNotifications,
} from "@/lib/workspace-notifications";

export function NotificationCenter() {
  const items = useSyncExternalStore(
    subscribeNotifications,
    getNotifications,
    getNotifications,
  );

  if (items.length === 0) {
    return (
      <p className="text-xs text-zinc-500" aria-live="polite">
        No notifications
      </p>
    );
  }

  return (
    <section aria-label="Notifications" className="min-w-[12rem]">
      <p className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
        Status
      </p>
      <ul className="mt-1 max-h-40 space-y-1 overflow-auto">
        {items.slice(0, 5).map((item) => (
          <li
            key={item.id}
            className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs font-medium text-zinc-900">{item.title}</p>
                {item.detail ? (
                  <p className="text-[11px] text-zinc-600">{item.detail}</p>
                ) : null}
                {item.href ? (
                  <Link
                    href={item.href}
                    className="text-[11px] text-teal-800 underline"
                  >
                    Open
                  </Link>
                ) : null}
              </div>
              <button
                type="button"
                className="text-[11px] text-zinc-500 hover:text-zinc-800"
                onClick={() => dismissNotification(item.id)}
                aria-label={`Dismiss notification: ${item.title}`}
              >
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
