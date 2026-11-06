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

export type StoryRef = Schemas["StoryRef"];
export type StoryDetail = Schemas["StoryDetail"];

export function storyRef(over: Partial<StoryRef> = {}): StoryRef {
  return { id: 2, epic_id: 1, name: "Other", state: "draft", ...over };
}

/** A story as GET /stories/{id} returns it: the story plus its relations. */
export function storyDetail(over: Partial<StoryDetail> = {}): StoryDetail {
  return { ...story(), depends_on: [], dependents: [], issues: [], pull_requests: [], ...over } as StoryDetail;
}

export type Comment = Schemas["Comment"];

export function comment(over: Partial<Comment> = {}): Comment {
  return { id: 1, entity_type: "story", entity_id: 1, body: "A comment", author: "", created_at: "2026-01-02T03:04:05.000Z", ...over };
}

export type HistoryEntry = Schemas["HistoryEntry"];

export function historyEntry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 1,
    entity_type: "epic",
    entity_id: 1,
    from_state: "draft",
    to_state: "review",
    reason: "",
    actor: "",
    at: "2026-01-02T03:04:05.000Z",
    ...over,
  };
}

export type Project = Schemas["Project"];

export function project(over: Partial<Project> = {}): Project {
  return { id: 1, name: "Alpha", description: "", created_at: stamp, updated_at: stamp, ...over };
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

type Route = unknown | Response | ((req: Request) => unknown | Response | Promise<unknown | Response>);

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
    if (typeof route === "function") route = await (route as (r: Request) => unknown)(req);
    return route instanceof Response ? route.clone() : json(route);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}
