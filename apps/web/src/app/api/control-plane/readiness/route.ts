import { READINESS_PATH } from "@/lib/config";
import { forwardControlPlane } from "../forward";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return forwardControlPlane(request, {
    path: READINESS_PATH,
    instance: "/api/control-plane/readiness",
  });
}
