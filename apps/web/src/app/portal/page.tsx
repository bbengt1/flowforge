import { redirect } from "next/navigation";
import { PORTAL_ENTRY_PATH } from "@/lib/portal-adapter-contract";

/** `/portal` is not a product tree — send hosts to the published entry path. */
export default function PortalIndexRedirect() {
  redirect(PORTAL_ENTRY_PATH);
}
