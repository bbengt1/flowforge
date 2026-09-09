/**
 * Monotonic request gate so a slower poll/refresh cannot overwrite a
 * newer cancel, retry, or later poll.
 */
export function createGenerationGate() {
  let current = 0;
  return {
    begin(): number {
      current += 1;
      return current;
    },
    isCurrent(token: number): boolean {
      return token === current;
    },
  };
}
