"use client";

/**
 * Keyset "Load more". The opaque `next` cursor stays in memory and is
 * sent only on the following list request — never rendered, stored, or
 * written into the address bar.
 */
export function CollectionLoadMore({
  next,
  pending = false,
  onLoadMore,
  label = "Load more",
}: {
  next: string;
  pending?: boolean;
  onLoadMore: () => void;
  label?: string;
}) {
  if (!next.trim()) {
    return null;
  }
  return (
    <div className="flex justify-center pt-3">
      <button
        type="button"
        data-collection-load-more="true"
        onClick={onLoadMore}
        disabled={pending}
        className="rounded-lg border border-border bg-bg px-3 py-1.5 text-sm font-medium text-fg hover:bg-fg/10 disabled:opacity-60"
      >
        {pending ? "Loading…" : label}
      </button>
    </div>
  );
}
