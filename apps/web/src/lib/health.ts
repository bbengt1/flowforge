import { getApiInternalUrl, HEALTH_PATH } from "./config";

export type HealthCheck = {
  ok: boolean;
  statusCode: number | null;
  status: string | null;
  error: string | null;
};

export async function checkApiHealth(): Promise<HealthCheck> {
  const url = `${getApiInternalUrl()}${HEALTH_PATH}`;

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
      headers: { Accept: "application/json" },
    });

    let status: string | null = null;
    try {
      const body: unknown = await response.json();
      if (
        body &&
        typeof body === "object" &&
        "status" in body &&
        typeof body.status === "string"
      ) {
        status = body.status;
      }
    } catch {
      status = null;
    }

    return {
      ok: response.ok && status === "ok",
      statusCode: response.status,
      status,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : "";
    const message =
      !raw || raw === "fetch failed" ? "Control plane unreachable" : raw;
    return {
      ok: false,
      statusCode: null,
      status: null,
      error: message,
    };
  }
}
