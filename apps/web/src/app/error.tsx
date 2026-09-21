"use client";

import { RouteErrorPanel } from "@/components/chrome/RouteErrorPanel";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteErrorPanel error={error} reset={reset} />;
}
