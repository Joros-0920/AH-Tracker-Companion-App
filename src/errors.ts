// Errors that carry an HTTP status, and reading a message from anything thrown.

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The status to answer with for a thrown value: its own if it has one, else 500. */
export const statusOf = (err: unknown): number => (err instanceof HttpError ? err.status : 500);

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
