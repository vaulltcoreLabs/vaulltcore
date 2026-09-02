import { describe, it, expect } from "vitest";
import { ApiError, parseApiError, getErrorUserMessage } from "@/lib/errors";

describe("ApiError", () => {
  it("creates an error with status and code", () => {
    const error = new ApiError(404, "NOT_FOUND", "Resource not found");
    expect(error.status).toBe(404);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("Resource not found");
    expect(error.name).toBe("ApiError");
  });

  it("has correct getter properties", () => {
    expect(new ApiError(401, "UNAUTH", "").isAuthError).toBe(true);
    expect(new ApiError(403, "FORBID", "").isForbidden).toBe(true);
    expect(new ApiError(404, "NF", "").isNotFound).toBe(true);
    expect(new ApiError(409, "CONFLICT", "").isConflict).toBe(true);
    expect(new ApiError(425, "INFLIGHT", "").isIdempotencyInflight).toBe(true);
    expect(new ApiError(422, "INVALID", "").isValidationError).toBe(true);
    expect(new ApiError(429, "QUOTA", "").isRateLimited).toBe(true);
    expect(new ApiError(500, "INTERNAL", "").isServerError).toBe(true);
    expect(new ApiError(200, "OK", "").isAuthError).toBe(false);
  });
});

describe("parseApiError", () => {
  it("parses JSON error response", async () => {
    const response = new Response(
      JSON.stringify({ error: { code: "NOT_FOUND", message: "Job not found" } }),
      { status: 404, statusText: "Not Found" }
    );
    const error = await parseApiError(response);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("Job not found");
  });

  it("handles non-JSON response gracefully", async () => {
    const response = new Response("Internal Server Error", {
      status: 500,
      statusText: "Internal Server Error",
    });
    const error = await parseApiError(response);
    expect(error.status).toBe(500);
    expect(error.code).toBe("PARSE_ERROR");
    expect(error.message).toContain("500");
  });

  it("handles JSON with missing error fields", async () => {
    const response = new Response(JSON.stringify({}), {
      status: 422,
      statusText: "Unprocessable Entity",
    });
    const error = await parseApiError(response);
    expect(error.status).toBe(422);
    expect(error.code).toBe("UNKNOWN");
    expect(error.message).toBe("An unexpected error occurred");
  });
});

describe("getErrorUserMessage", () => {
  it("returns session expired for 401", () => {
    const msg = getErrorUserMessage(new ApiError(401, "UNAUTH", "unauthorized"));
    expect(msg).toContain("session");
  });

  it("returns permission message for 403", () => {
    const msg = getErrorUserMessage(new ApiError(403, "FORBID", "forbidden"));
    expect(msg).toContain("permission");
  });

  it("returns not found for 404", () => {
    const msg = getErrorUserMessage(new ApiError(404, "NF", "not found"));
    expect(msg).toContain("not found");
  });

  it("returns conflict message for 409", () => {
    const msg = getErrorUserMessage(new ApiError(409, "CONFLICT", "conflict"));
    expect(msg).toContain("conflict");
  });

  it("returns validation message for 422 with custom message", () => {
    const msg = getErrorUserMessage(new ApiError(422, "INVALID", "branch is required"));
    expect(msg).toBe("branch is required");
  });

  it("returns inflight message for 425", () => {
    const msg = getErrorUserMessage(new ApiError(425, "INFLIGHT", "in progress"));
    expect(msg).toContain("progress");
  });

  it("returns rate limit message for 429", () => {
    const msg = getErrorUserMessage(new ApiError(429, "QUOTA", "too many"));
    expect(msg).toContain("Too many");
  });

  it("returns server error for 500", () => {
    const msg = getErrorUserMessage(new ApiError(500, "INTERNAL", "server error"));
    expect(msg).toContain("server error");
  });
});
