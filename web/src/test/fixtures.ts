import type { Schemas } from "../api/client";

export type Epic = Schemas["Epic"];
export type Story = Schemas["Story"];

const stamp = "2026-01-01T00:00:00Z";

export function epic(over: Partial<Epic> = {}): Epic {
  return {
    id: 1,
    project_id: 1,
    name: "Epic",
    description: "",
    state: "draft",
    tags: [],
    allowed_transitions: [],
    created_at: stamp,
    updated_at: stamp,
    ...over,
  };
}

export function story(over: Partial<Story> = {}): Story {
  return {
    id: 1,
    project_id: 1,
    epic_id: 1,
    name: "Story",
    description: "",
    acceptance_criteria: "",
    state: "draft",
    estimate_loc: null,
    assignee: "",
    tags: [],
    warnings: [],
    allowed_transitions: [],
    created_at: stamp,
    updated_at: stamp,
    ...over,
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json" },
  });
}

export function problem(status: number, title: string, detail: string): Response {
  return json({ title, status, detail }, status);
}

type Route = unknown | Response | (() => unknown | Response);

/**
 * A fetch stand-in that answers by URL path. A route value may be a plain body,
 * a ready-made Response, or a function evaluated on every request (to change
 * its answer over time). Unknown paths answer 404. `calls` records the paths.
 */
export function mockApi(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (req: Request) => {
    const path = new URL(req.url).pathname;
    calls.push(path);
    let route = routes[path];
    if (route === undefined) return problem(404, "not found", `no route for ${path}`);
    if (typeof route === "function") route = (route as () => unknown)();
    return route instanceof Response ? route.clone() : json(route);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}
