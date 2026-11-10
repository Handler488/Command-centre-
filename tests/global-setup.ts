import { startMockUpstream } from './fixtures/upstream.ts';

export default async function setup() {
  const server = await startMockUpstream(4599);
  return () => new Promise<void>((resolve) => server.close(() => resolve()));
}
