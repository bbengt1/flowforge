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
      <p className="ff-shell-muted text-xs" aria-live="polite">
        No notifications
      </p>
    );
  }

  return (
    <section aria-label="Notifications" className="min-w-[12rem]">
      <p className="ff-nav-group-label text-[11px] font-medium tracking-wide uppercase">
        Status
      </p>
      <ul className="mt-1 max-h-40 space-y-1 overflow-auto">
        {items.slice(0, 5).map((item) => (
          <li
            key={item.id}
            className="ff-shell-panel px-2 py-1.5"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs font-medium">{item.title}</p>
                {item.detail ? (
                  <p className="ff-shell-muted text-[11px]">{item.detail}</p>
                ) : null}
                {item.href ? (
                  <Link
                    href={item.href}
                    className="text-[11px] underline text-[var(--ff-accent)]"
                  >
                    Open
                  </Link>
                ) : null}
              </div>
              <button
                type="button"
                className="ff-shell-muted text-[11px] hover:text-[var(--ff-text)]"
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
