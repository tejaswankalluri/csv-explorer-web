let counter = 0;

export function generateRequestId(): string {
  return `req_${++counter}_${Date.now()}`;
}
