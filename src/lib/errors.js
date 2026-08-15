/**
 * Typed application errors. Every one carries the HTTP status it should map to,
 * so route handlers can just `throw` and the error middleware does the rest.
 */
export class AppError extends Error {
  constructor(message, { status = 500, code = 'internal_error', details = null } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details = null) {
    // 422: syntactically valid JSON, semantically invalid content.
    super(message, { status: 422, code: 'validation_error', details });
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details = null) {
    super(message, { status: 400, code: 'bad_request', details });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', details = null) {
    super(message, { status: 404, code: 'not_found', details });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', details = null) {
    super(message, { status: 401, code: 'unauthorized', details });
  }
}
