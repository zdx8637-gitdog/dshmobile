export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public retriable: boolean = false
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class AuthError extends AppError {
  constructor(message: string, retriable: boolean = false) {
    super(401, "AUTH_ERROR", message, retriable);
    this.name = "AuthError";
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = "Resource not found") {
    super(404, "NOT_FOUND", message, false);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = "Forbidden") {
    super(403, "FORBIDDEN", message, false);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, "CONFLICT", message, false);
    this.name = "ConflictError";
  }
}

export class RateLimitError extends AppError {
  constructor(message: string = "Too many requests") {
    super(429, "RATE_LIMITED", message, true);
    this.name = "RateLimitError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, "VALIDATION_ERROR", message, false);
    this.name = "ValidationError";
  }
}
