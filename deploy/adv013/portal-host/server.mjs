#!/usr/bin/env node
/**
 * ADV-013 Portal demo host + optional TLS terminator.
 *
 * Three HTTPS origins (default):
 *   https://portal.test:8443  — Portal entry / mint proxy / iframe parent
 *   https://embed.test:8444   — reverse-proxy to FlowForge web (Next)
 *   https://evil.test:8445    — hostile ancestor (must be blocked by CSP)
 *
 * Relates to #144. This is evidence/harness only — not a product Portal.
 */

import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "public");

const PORTAL_ORIGIN = process.env.ADV013_PORTAL_ORIGIN || "https://portal.test:8443";
const EMBED_ORIGIN = process.env.ADV013_EMBED_ORIGIN || "https://embed.test:8444";
const EVIL_ORIGIN = process.env.ADV013_EVIL_ORIGIN || "https://evil.test:8445";
const API_URL = (process.env.ADV013_API_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const WEB_URL = (process.env.ADV013_WEB_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const CERT = process.env.ADV013_TLS_CERT || join(here, "..", "tls", "harness.pem");
const KEY = process.env.ADV013_TLS_KEY || join(here, "..", "tls", "harness-key.pem");

const PORTAL_PORT = Number(new URL(PORTAL_ORIGIN).port || 8443);
const EMBED_PORT = Number(new URL(EMBED_ORIGIN).port || 8444);
const EVIL_PORT = Number(new URL(EVIL_ORIGIN).port || 8445);

const PORTAL_ISSUER = process.env.PORTAL_ISSUER || "https://portal.cp-ops.example";
const PORTAL_SUBJECT = process.env.ADV013_PORTAL_SUBJECT || "portal-user-1";
const ADMIN_ISSUER = process.env.ADV013_ADMIN_ISSUER || "https://idp.example";
const ADMIN_SUBJECT = process.env.ADV013_ADMIN_SUBJECT || "admin-1";
const TENANT_SLUG = process.env.ADV013_TENANT_SLUG || "acme";
const WORKBENCH = process.env.ADV013_WORKBENCH || "ops";

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function html(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readPublic(name) {
  return readFileSync(join(publicDir, name), "utf8");
}

function renderPortalPage() {
  return readPublic("index.html")
    .replaceAll("{{PORTAL_ORIGIN}}", PORTAL_ORIGIN)
    .replaceAll("{{EMBED_ORIGIN}}", EMBED_ORIGIN)
    .replaceAll("{{EVIL_ORIGIN}}", EVIL_ORIGIN);
}

function renderHostilePage() {
  return readPublic("hostile.html").replaceAll("{{EMBED_ORIGIN}}", EMBED_ORIGIN);
}

async function api(method, path, { headers = {}, body, identity } = {}) {
  const nextHeaders = {
    accept: "application/json",
    "x-request-id": `adv013-${Date.now()}`,
    ...headers,
  };
  if (identity) {
    nextHeaders["x-flowforge-issuer"] = identity.issuer;
    nextHeaders["x-flowforge-subject"] = identity.subject;
    nextHeaders["x-flowforge-display-name"] = identity.displayName || identity.subject;
    if (identity.tenantId) {
      nextHeaders["x-flowforge-tenant-id"] = identity.tenantId;
    }
    if (identity.tenantSlug) {
      nextHeaders["x-flowforge-tenant-slug"] = identity.tenantSlug;
    }
    if (identity.workbenchKey) {
      nextHeaders["x-flowforge-workbench-key"] = identity.workbenchKey;
    }
  }
  let payload;
  if (body !== undefined) {
    nextHeaders["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: nextHeaders,
    body: payload,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { ok: response.ok, status: response.status, data, headers: response.headers };
}

function adminIdentity() {
  return {
    issuer: ADMIN_ISSUER,
    subject: ADMIN_SUBJECT,
    displayName: "ADV-013 admin",
    tenantSlug: TENANT_SLUG,
    workbenchKey: WORKBENCH,
  };
}

function portalIdentity(tenantId) {
  return {
    issuer: PORTAL_ISSUER,
    subject: PORTAL_SUBJECT,
    displayName: "ADV-013 portal user",
    tenantId,
    tenantSlug: TENANT_SLUG,
    workbenchKey: WORKBENCH,
  };
}

async function handlePortal(req, res) {
  const url = new URL(req.url || "/", PORTAL_ORIGIN);
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    html(res, 200, renderPortalPage());
    return;
  }
  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { status: "ok", origin: PORTAL_ORIGIN, embed: EMBED_ORIGIN });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/config") {
    json(res, 200, {
      portalOrigin: PORTAL_ORIGIN,
      embedOrigin: EMBED_ORIGIN,
      evilOrigin: EVIL_ORIGIN,
      mount: "/embed/v1/workflows",
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/adapter") {
    const result = await api("GET", "/api/v1/portal/adapter");
    json(res, result.status, result.data);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/bootstrap") {
    const tenant = await api("POST", "/api/v1/tenants", {
      identity: adminIdentity(),
      body: { slug: TENANT_SLUG, name: "Acme ADV-013" },
    });
    if (!tenant.ok && tenant.status !== 409) {
      json(res, tenant.status, { step: "tenant", ...tenant.data });
      return;
    }
    const workspace = await api("POST", "/api/v1/workspaces", {
      identity: adminIdentity(),
      body: { tenant_slug: TENANT_SLUG, workbench_key: WORKBENCH, name: "Ops" },
    });
    if (!workspace.ok && workspace.status !== 409) {
      json(res, workspace.status, { step: "workspace", ...workspace.data });
      return;
    }
    const current = await api("GET", "/api/v1/workspace", {
      identity: adminIdentity(),
    });
    if (!current.ok) {
      json(res, current.status, { step: "workspace-lookup", ...current.data });
      return;
    }
    const tenantId = current.data?.tenant?.id || current.data?.workspace?.tenant_id;
    const member = await api("PUT", "/api/v1/workspace/members", {
      identity: { ...adminIdentity(), tenantId },
      body: {
        issuer: PORTAL_ISSUER,
        external_subject: PORTAL_SUBJECT,
        display_name: "ADV-013 portal user",
        role_keys: ["viewer"],
      },
    });
    if (!member.ok) {
      json(res, member.status, { step: "member", ...member.data });
      return;
    }
    json(res, 200, {
      tenantId,
      workbenchKey: WORKBENCH,
      tenantSlug: TENANT_SLUG,
      portalSubject: PORTAL_SUBJECT,
      portalIssuer: PORTAL_ISSUER,
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/mint") {
    const current = await api("GET", "/api/v1/workspace", {
      identity: adminIdentity(),
    });
    const tenantId = current.data?.tenant?.id || "";
    const result = await api("POST", "/api/v1/portal/adapter/assertions", {
      identity: portalIdentity(tenantId),
      body: {
        portalRoles: ["portal.viewer"],
        displayName: "ADV-013 portal user",
        ttlSeconds: 120,
      },
    });
    const assertion =
      result.ok && typeof result.data?.assertion === "string"
        ? result.data.assertion
        : "";
    json(res, result.status, {
      ok: result.ok,
      tokenId: result.data?.tokenId || result.data?.jti || "",
      audience: result.data?.audience,
      issuer: result.data?.issuer,
      subject: result.data?.subject,
      assertion,
      status: result.status,
      problem: result.ok ? null : result.data,
    });
    return;
  }
  json(res, 404, { title: "Not found" });
}

async function handleEvil(req, res) {
  const url = new URL(req.url || "/", EVIL_ORIGIN);
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/hostile.html")) {
    html(res, 200, renderHostilePage());
    return;
  }
  json(res, 404, { title: "Not found" });
}

async function proxyEmbed(req, res) {
  const target = `${WEB_URL}${req.url || "/"}`;
  const headers = { ...req.headers, host: new URL(WEB_URL).host };
  headers["x-forwarded-proto"] = "https";
  headers["x-forwarded-host"] = new URL(EMBED_ORIGIN).host;
  delete headers["content-length"];
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method || "GET") ? undefined : body,
      redirect: "manual",
    });
  } catch (error) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ title: "embed proxy failed", detail: String(error) }));
    return;
  }
  const outHeaders = {};
  upstream.headers.forEach((value, key) => {
    if (key === "transfer-encoding") {
      return;
    }
    if (outHeaders[key]) {
      const current = outHeaders[key];
      outHeaders[key] = Array.isArray(current) ? [...current, value] : [current, value];
    } else {
      outHeaders[key] = value;
    }
  });
  const setCookies =
    typeof upstream.headers.getSetCookie === "function"
      ? upstream.headers.getSetCookie()
      : [];
  res.writeHead(upstream.status, {
    ...outHeaders,
    ...(setCookies.length > 0 ? { "set-cookie": setCookies } : {}),
  });
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.end(buf);
}

function listen(kind, server, port) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(`adv013 ${kind} listening on 127.0.0.1:${port}`);
      resolve();
    });
  });
}

const useTls = existsSync(CERT) && existsSync(KEY);
const tlsOpts = useTls
  ? { cert: readFileSync(CERT), key: readFileSync(KEY) }
  : null;
if (!useTls) {
  console.warn("adv013: TLS certs missing; serving HTTP (CHIPS evidence needs HTTPS)");
}

const create = (handler) =>
  useTls ? createHttpsServer(tlsOpts, handler) : createHttpServer(handler);

await listen("portal", create(handlePortal), PORTAL_PORT);
await listen("embed-proxy", create(proxyEmbed), EMBED_PORT);
await listen("evil", create(handleEvil), EVIL_PORT);
