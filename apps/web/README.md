# `@flowforge/web`

Next.js App Router UI for FlowForge. Compose builds this image with `context: ./apps/web`. Local and stack startup are documented in the repository root `README.md` and `docs/deployment.md`.

The production image runs as UID/GID `65532` (same as `apps/api`). Compose adds a read-only root filesystem, tmpfs, dropped capabilities, `no-new-privileges`, and resource limits. Responses include the E1.3 secure-header set (`apps/web/src/lib/security-headers.ts`); HSTS is omitted on `http://localhost:3000`.
