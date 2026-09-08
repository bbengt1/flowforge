import { HEALTH_PATH, READINESS_PATH } from "./config";
import {
  fetchControlPlane,
  toProbe,
  type ControlPlaneProbe,
} from "./control-plane";

export type { ControlPlaneProbe };

export async function checkApiHealth(
  requestId?: string,
): Promise<ControlPlaneProbe> {
  return toProbe(
    await fetchControlPlane(HEALTH_PATH, {
      requestId,
      instance: "/api/control-plane/health",
    }),
    "ok",
  );
}

export async function checkApiReadiness(
  requestId?: string,
): Promise<ControlPlaneProbe> {
  return toProbe(
    await fetchControlPlane(READINESS_PATH, {
      requestId,
      instance: "/api/control-plane/readiness",
    }),
    "ready",
  );
}
