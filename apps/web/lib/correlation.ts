const HEADER = 'x-correlation-id';
const PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function correlationId(request: Request): string {
  const incoming = request.headers.get(HEADER);
  if (incoming && PATTERN.test(incoming)) return incoming;
  return crypto.randomUUID();
}

export function withCorrelation(response: Response, id: string): Response {
  response.headers.set(HEADER, id);
  return response;
}
