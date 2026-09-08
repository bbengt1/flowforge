export const HEALTH_PATH = "/api/v1/health";
export const READINESS_PATH = "/api/v1/readiness";
export const OPENAPI_YAML_PATH = "/api/v1/openapi.yaml";
export const OPENAPI_JSON_PATH = "/api/v1/openapi.json";
export const SWAGGER_PATH = "/api/v1/swagger";

const DEFAULT_API_ORIGIN = "http://localhost:8080";

/** Origin the Next.js server uses to reach the Go API (Compose: http://api:8080). */
export function getApiInternalUrl(): string {
  return (
    process.env.API_INTERNAL_URL?.replace(/\/$/, "") ||
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ||
    DEFAULT_API_ORIGIN
  );
}

/** Origin shown to operators on the host machine. */
export function getApiPublicUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || DEFAULT_API_ORIGIN;
}

export function getPublicHealthUrl(): string {
  return `${getApiPublicUrl()}${HEALTH_PATH}`;
}

export function getPublicReadinessUrl(): string {
  return `${getApiPublicUrl()}${READINESS_PATH}`;
}

export function getPublicOpenApiYamlUrl(): string {
  return `${getApiPublicUrl()}${OPENAPI_YAML_PATH}`;
}

export function getPublicOpenApiJsonUrl(): string {
  return `${getApiPublicUrl()}${OPENAPI_JSON_PATH}`;
}

export function getPublicSwaggerUrl(): string {
  return `${getApiPublicUrl()}${SWAGGER_PATH}`;
}
