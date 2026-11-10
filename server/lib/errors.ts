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

/** An upstream data provider failed or returned something unusable. */
export class UpstreamError extends AppError {
  constructor(
    public provider: string,
    message: string,
    public upstreamStatus?: number,
  ) {
    super(502, 'upstream_unavailable', `${provider}: ${message}`);
    this.name = 'UpstreamError';
  }
}
