import createClient from "openapi-fetch";
import type { components, paths } from "./schema";

export type Schemas = components["schemas"];
export type Problem = Schemas["Problem"];

// `fetch` is looked up at call time so tests can stub globalThis.fetch.
export const api = createClient<paths>({
  baseUrl: `${globalThis.location?.origin ?? "http://localhost"}/api/v1`,
  fetch: (req) => globalThis.fetch(req),
});

/** Error carrying the RFC 7807-style problem document returned by the server. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public problem?: Problem,
  ) {
    super(problem?.detail || problem?.title || `HTTP ${status}`);
  }
}

type Result<T> = { data?: T; error?: unknown; response: Response };

function asProblem(error: unknown): Problem | undefined {
  return typeof error === "object" && error !== null && "title" in error
    ? (error as Problem)
    : undefined;
}

/** Resolves with the response data, or throws ApiError for non-2xx responses. */
export async function unwrap<T>(result: Promise<Result<T>>): Promise<T> {
  const { data, error, response } = await result;
  if (!response.ok) throw new ApiError(response.status, asProblem(error));
  return data as T;
}
