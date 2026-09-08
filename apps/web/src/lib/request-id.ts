export const REQUEST_ID_HEADER = "X-Request-ID";

const MIN_LENGTH = 16;
const MAX_LENGTH = 128;

/** Matches the control-plane rule: 16–128 ASCII letters, digits, or hyphens. */
export function isValidRequestId(value: string): boolean {
  if (value.length < MIN_LENGTH || value.length > MAX_LENGTH) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code > 127) {
      return false;
    }
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    const isHyphen = code === 45;
    if (!isUpper && !isLower && !isDigit && !isHyphen) {
      return false;
    }
  }
  return true;
}

/** 32-character hex ID, same shape the Go API generates. */
export function generateRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function resolveRequestId(incoming: string | null | undefined): string {
  return incoming && isValidRequestId(incoming)
    ? incoming
    : generateRequestId();
}
