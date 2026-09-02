import type { ApiErrorBody, ApiErrorCode } from "@/types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  get isAuthError() {
    return this.status === 401;
  }
  get isForbidden() {
    return this.status === 403;
  }
  get isNotFound() {
    return this.status === 404;
  }
  get isConflict() {
    return this.status === 409;
  }
  get isIdempotencyInflight() {
    return this.status === 425;
  }
  get isValidationError() {
    return this.status === 422;
  }
  get isRateLimited() {
    return this.status === 429;
  }
  get isServerError() {
    return this.status >= 500;
  }
}

export async function parseApiError(response: Response): Promise<ApiError> {
  try {
    const body: ApiErrorBody = await response.json();
    return new ApiError(
      response.status,
      body.error?.code ?? "UNKNOWN",
      body.error?.message ?? "An unexpected error occurred"
    );
  } catch {
    return new ApiError(
      response.status,
      "PARSE_ERROR",
      `HTTP ${response.status}: ${response.statusText}`
    );
  }
}

export function getErrorUserMessage(error: ApiError): string {
  switch (error.status) {
    case 401:
      return "Your session has expired. Please sign in again.";
    case 403:
      return "You don't have permission to perform this action.";
    case 404:
      return "Resource not found.";
    case 409:
      return "This operation conflicts with a recent change. Please refresh and try again.";
    case 422:
      return error.message || "Please check your input and try again.";
    case 425:
      return "This operation is already in progress. Please wait a moment.";
    case 429:
      return "Too many requests. Please try again later.";
    default:
      if (error.status >= 500) {
        return "A server error occurred. Please try again later.";
      }
      return error.message || "An unexpected error occurred.";
  }
}
