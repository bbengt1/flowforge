"use client";

import { useEffect, useState } from "react";
import { AuthorizedResourceSelect } from "@/components/config/AuthorizedResourceSelect";
import {
  authorizedHttpConnections,
  connectionSelectorLabel,
  isHttpConfigurableType,
} from "@/lib/core-http-notification-contract";
import { listOpsConfig, selectOpsConfig } from "@/lib/ops-config-client";
import type { DevIdentity } from "@/lib/identity-headers";
import type { OpsConfigKind, OpsConfigPin } from "@/lib/ops-config-types";
import type { ProblemDetails } from "@/lib/problem";

function kindsForType(type: string): OpsConfigKind[] {
  if (type === "http.request") {
    return ["connection", "response_schema"];
  }
  if (type === "notification.email") {
    return ["connection", "recipient_list", "message_template"];
  }
  if (type === "notification.webhook") {
    return ["connection"];
  }
  return [];
}

type HttpNotificationPinsPanelProps = {
  type: string;
  identity: DevIdentity;
  ready: boolean;
  values: Record<string, unknown>;
  disabled?: boolean;
  onPatch: (patch: Record<string, unknown>) => void;
};

const FIELD_FOR_KIND: Partial<Record<OpsConfigKind, string>> = {
  connection: "connectionId",
  recipient_list: "recipientListId",
  message_template: "templateId",
  response_schema: "responseSchemaRef",
};

export function HttpNotificationPinsPanel({
  type,
  identity,
  ready,
  values,
  disabled,
  onPatch,
}: HttpNotificationPinsPanelProps) {
  if (!isHttpConfigurableType(type)) {
    return null;
  }
  const kinds = kindsForType(type);
  return (
    <div className="space-y-4">
      {kinds.map((kind) => (
        <HttpNotificationPinSelect
          key={kind}
          kind={kind}
          type={type}
          identity={identity}
          ready={ready}
          value={
            typeof values[FIELD_FOR_KIND[kind] ?? ""] === "string"
              ? String(values[FIELD_FOR_KIND[kind] ?? ""])
              : ""
          }
          disabled={disabled}
          onChange={(pin) => {
            const field = FIELD_FOR_KIND[kind];
            if (!field) {
              return;
            }
            onPatch({ [field]: pin?.resourceId ?? "" });
          }}
        />
      ))}
      <p className="text-xs text-zinc-500">
        Published workspace pins only. Display name + version — never a URL,
        recipient address, or credential.
      </p>
    </div>
  );
}

type HttpNotificationPinSelectProps = {
  kind: OpsConfigKind;
  type: string;
  identity: DevIdentity;
  ready: boolean;
  value: string;
  disabled?: boolean;
  onChange: (pin: OpsConfigPin | null) => void;
};

function HttpNotificationPinSelect({
  kind,
  type,
  identity,
  ready,
  value,
  disabled,
  onChange,
}: HttpNotificationPinSelectProps) {
  const [pins, setPins] = useState<OpsConfigPin[]>([]);
  const [problem, setProblem] = useState<ProblemDetails | null>(null);
  const [statusCode, setStatusCode] = useState<number | undefined>();

  useEffect(() => {
    if (!ready) {
      return;
    }
    let cancelled = false;
    void listOpsConfig(identity, kind).then((result) => {
      if (cancelled) {
        return;
      }
      setStatusCode(result.statusCode);
      if (!result.ok) {
        setProblem(result.problem);
        setPins([]);
        return;
      }
      setProblem(null);
      const listed = result.items
        .filter((item) => item.status !== "disabled" && item.latestVersionId)
        .map((item) => ({
          kind,
          resourceId: item.id,
          versionId: item.latestVersionId ?? "",
          versionNumber: item.latestVersionNumber ?? 0,
          digest: item.latestVersionDigest ?? "",
          name: item.name,
          slug: item.slug,
          spec: item.spec,
        }));
      setPins(
        kind === "connection"
          ? authorizedHttpConnections({ pins: listed, nodeType: type }).options
          : listed,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [identity, ready, kind, type]);

  const selected = pins.find(
    (pin) => pin.resourceId === value || pin.versionId === value,
  );

  return (
    <AuthorizedResourceSelect
      kind={kind}
      label={
        kind === "connection"
          ? type === "notification.email"
            ? "Published SMTP connection"
            : type === "notification.webhook"
              ? "Published webhook connection"
              : "Published HTTP connection"
          : kind === "recipient_list"
            ? "Published recipient list"
            : kind === "message_template"
              ? "Published message template"
              : "Published response schema"
      }
      value={selected?.versionId ?? ""}
      pins={pins}
      problem={problem}
      statusCode={statusCode}
      disabled={disabled}
      optionLabel={kind === "connection" ? connectionSelectorLabel : undefined}
      onChange={(pin) => {
        if (!pin) {
          onChange(null);
          return;
        }
        void selectOpsConfig(identity, kind, pin.resourceId, pin.versionId).then(
          (result) => {
            if (!result.ok) {
              setProblem(result.problem);
              setStatusCode(result.statusCode);
              onChange(null);
              return;
            }
            setProblem(null);
            onChange(result.pin);
          },
        );
      }}
    />
  );
}
