/** Error carrying an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details);

/**
 * An upstream data provider failed or returned something unusable.
 * A provider's definitive "no such thing" (404) is surfaced as our own 404 so
 * clients can tell an unknown ticker from an outage (502).
 */
export class UpstreamError extends AppError {
  constructor(
    public provider: string,
    message: string,
    public upstreamStatus?: number,
  ) {
    super(upstreamStatus === 404 ? 404 : 502, upstreamStatus === 404 ? 'not_found' : 'upstream_unavailable', `${provider}: ${message}`);
    this.name = 'UpstreamError';
  }
}
