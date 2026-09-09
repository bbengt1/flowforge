import { redirect } from "next/navigation";
import { EMBED_MOUNT_PREFIX } from "@/lib/embed-contract";

/** `/embed` is not a product tree — send hosts to the published `/embed/v1` mount. */
export default function EmbedIndexRedirect() {
  redirect(EMBED_MOUNT_PREFIX);
}
