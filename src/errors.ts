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

export class SuuntoNotAuthenticatedError extends Error {
  constructor() {
    super(
      "Not authenticated. Run `npm run auth` to pair your Suunto account first.",
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
