export class SuuntoApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`Suunto API ${status} ${path}: ${body}`);
    this.name = "SuuntoApiError";
  }
}

export class SuuntoAuthError extends SuuntoApiError {
  constructor(path: string, body: string) {
    super(401, path, body);
    this.name = "SuuntoAuthError";
  }
}

export class SuuntoForbiddenError extends SuuntoApiError {
  constructor(path: string, body: string) {
    super(403, path, body);
    this.name = "SuuntoForbiddenError";
  }
}

export class SuuntoNotFoundError extends SuuntoApiError {
  constructor(path: string, body: string) {
    super(404, path, body);
    this.name = "SuuntoNotFoundError";
  }
}

// HTTP 200 with no body at all — Suunto's answer for a well-formed key that
// doesn't exist. A NotFound to callers, but a distinct class because the digest
// treats a plain 404/403 as "product not subscribed" and must NOT read an empty
// response from a subscribed endpoint that way.
export class SuuntoEmptyResponseError extends SuuntoNotFoundError {
  constructor(path: string) {
    super(path, "Suunto returned 200 with an empty body — the item does not exist.");
    this.name = "SuuntoEmptyResponseError";
  }
}

export class SuuntoRateLimitError extends SuuntoApiError {
  constructor(
    path: string,
    body: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(429, path, body);
    this.name = "SuuntoRateLimitError";
  }
}

// Suunto's gateway answers HTTP 401 for routes it no longer serves
// ("OperationNotFound"), indistinguishable by status from a real auth failure.
// Keeps status 401 and the raw body so callers that branch on either (the
// digest's degradesToNoData) still treat it as a hard failure.
export class SuuntoEndpointUnavailableError extends SuuntoApiError {
  constructor(path: string, body: string) {
    super(
      401,
      path,
      `${body}\n\nSuunto no longer serves this endpoint (the gateway reports OperationNotFound). This is not an authentication problem — re-pairing will not help.`,
    );
    this.name = "SuuntoEndpointUnavailableError";
  }
}

export class SuuntoNotAuthenticatedError extends Error {
  constructor() {
    super(
      "Not authenticated. Pair your Suunto account first: `npm run auth` (from the cloned folder) or `npx -p suunto-mcp suunto-mcp-auth` (npm install).",
    );
    this.name = "SuuntoNotAuthenticatedError";
  }
}

export class SuuntoTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuuntoTokenError";
  }
}
