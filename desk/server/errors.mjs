// Errors that map to HTTP statuses. Everything else is a 500.
export class HttpError extends Error {
  constructor(status, message, body = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export const conflict = (message, body) => new HttpError(409, message, body);
export const badRequest = (message, body) => new HttpError(400, message, body);
export const unprocessable = (message, body) => new HttpError(422, message, body);
