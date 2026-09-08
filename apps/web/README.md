# `@flowforge/web`

Next.js App Router UI for FlowForge. Compose builds this image with `context: ./apps/web`. Local and stack startup are documented in the repository root `README.md` and `docs/deployment.md`.

The production image runs as UID/GID `65532` (same as `apps/api`). Compose adds a read-only root filesystem, tmpfs, dropped capabilities, `no-new-privileges`, and resource limits. Responses include the E1.3 secure-header set (`apps/web/src/lib/security-headers.ts`); HSTS is omitted on `http://localhost:3000`.

`/membership` is the E2.1 / E2.3 operator UI (Chloe). `/isolation` is the E2.2 negative isolation exercise (also embedded on `/membership`). Both proxy jonny's `/api/v1` routes under `/api/control-plane/*` with `credentials: include`, CSRF on mutations, FlowForge workspace headers, and `X-Request-ID`. Cookie session is preferred. Temporary local-dev header identity is opt-in and labeled as such. Workspace lookup is tenant + workbench key, never a host-supplied workspace UUID. Bearer tokens are never stored in `localStorage` or the URL.
