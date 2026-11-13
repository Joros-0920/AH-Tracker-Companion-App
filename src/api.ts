// Client for the AH Tracker price server (API described in docs/DESIGN.md).
import zlib from 'node:zlib';
import type { ItemName, Scan } from './savedVars.ts';

const USER_AGENT = 'AHTrackerCompanion/0.1';
const TIMEOUT = 30_000;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface UploadResult { ok: boolean; points: number; skipped: number }

export interface PricesResponse {
  realm: string;
  generated: number;
  /** false when only items changed since `since` came back */
  full?: boolean;
  /** pass back as `since` to get only what changed after this answer */
  cursor?: number | null;
  /** itemID -> packed history */
  items?: Record<string, string>;
  names?: Record<string, ItemName>;
}

export class ApiClient {
  baseUrl: string;
  apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' };
    let payload: Buffer | undefined;
    if (body !== undefined) {
      payload = zlib.gzipSync(JSON.stringify(body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Encoding'] = 'gzip';
    }
    const res = await fetch(this.baseUrl + path, { method, headers, body: payload, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, `${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
    }
    return (res.status === 204 ? null : await res.json()) as T;
  }

  /** scans: [{ t, items: [[itemID, min, mkt, qty], ...] }]; names (optional): { itemID: { n, q } } */
  uploadScans(realm: string, scans: Scan[], names?: Record<string, ItemName>): Promise<UploadResult | null> {
    return this.request('POST', '/v1/scans', names ? { realm, scans, names } : { realm, scans });
  }

  /**
   * Returns { realm, generated, full, items: { itemID: "packed history" }, names }.
   * since: the `cursor` from an earlier answer; then only items that changed after it come back
   * (full: false). Servers without that support send everything.
   */
  prices(realm: string, days: number, since?: number): Promise<PricesResponse> {
    const q = since ? `&since=${since}` : '';
    return this.request('GET', `/v1/realms/${encodeURIComponent(realm)}/prices?days=${days}${q}`);
  }
}
