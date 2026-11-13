// Shared bits for the tests.
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Starts `server` on a free local port and resolves to its base URL. */
export async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * A response body as JSON. The tests check the fields they read, so it's typed loosely
 * on purpose: asserting on the server's answers is what they're for.
 */
// oxlint-disable-next-line typescript/no-explicit-any
export type Json = any;
export const json = async (res: Response | Promise<Response>): Promise<Json> => (await res).json();

/** A response header that has to be there. */
export function header(res: Response, name: string): string {
  const v = res.headers.get(name);
  if (v === null) throw new Error(`No ${name} header`);
  return v;
}
