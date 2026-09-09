import { notFound } from "next/navigation";
import { ConfigKindList } from "@/components/config/ConfigKindList";
import { kubernetesOpsKind } from "@/lib/kubernetes";
import { kindFromCollection } from "@/lib/ops-config-contract";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ kind: string }>;
};

export default async function ConfigKindPage({ params }: PageProps) {
  const { kind: collection } = await params;
  const kind = kindFromCollection(collection);
  if (!kind) {
    notFound();
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-wide text-teal-800 uppercase">
          {kubernetesOpsKind(kind) ? "E4.2 · E7.1" : "E4.2"} ·{" "}
          {kind.replaceAll("_", " ")}
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          {kind.replaceAll("_", " ")}
        </h1>
        <p className="max-w-3xl text-base leading-7 text-zinc-600">
          List workspace heads, then create or edit a draft and publish an
          immutable pin. Select uses POST …/select. Foreign or empty lists fail
          closed with problem+json.
          {kind === "cluster_target"
            ? " Cluster targets bind a workspace kubernetes credential by display name and an optional Kubernetes policy. The UI never receives kubeconfigs."
            : kind === "policy"
              ? " Kubernetes policies allowlist namespaces, kinds, and verbs and can require approval for apply."
              : ""}
        </p>
      </header>
      <ConfigKindList kind={kind} />
    </main>
  );
}
