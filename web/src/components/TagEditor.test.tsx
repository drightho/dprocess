import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import TagEditor from "./TagEditor";
import { api, unwrap } from "../api/client";
import { epic, mockApi, problem, storyDetail } from "../test/fixtures";

// A page-like harness: the tags come from a query, so a successful change shows up after the refetch, as on the real pages.
function Harness({ kind }: { kind: "epic" | "story" }) {
  const q = useQuery({
    queryKey: [kind, 1],
    queryFn: async () =>
      kind === "epic"
        ? (await unwrap(api.GET("/epics/{id}", { params: { path: { id: 1 } } }))).tags
        : (await unwrap(api.GET("/stories/{id}", { params: { path: { id: 1 } } }))).tags,
  });
  if (!q.data) return <p>loading</p>;
  return <TagEditor kind={kind} id={1} projectId={3} epicId={2} tags={q.data} />;
}

function renderEditor(kind: "epic" | "story" = "story") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Harness kind={kind} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { invalidate };
}

/** A stateful fake of the tag endpoints; like the server it trims and lower-cases, and refuses odd tags. */
function server(kind: "epic" | "story", initial: string[], refuse?: (tag: string) => Response | undefined) {
  const state = { tags: [...initial], calls: [] as string[] };
  const base = kind === "epic" ? "/api/v1/epics/1" : "/api/v1/stories/1";
  const entity = () => (kind === "epic" ? { ...epic({ id: 1 }), allowed_transitions: [], tags: state.tags } : { ...storyDetail({ id: 1 }), tags: state.tags });
  const tagRoute = (raw: string) => async (req: Request) => {
    const tag = raw.toLowerCase();
    state.calls.push(`${req.method} ${tag}`);
    const refused = refuse?.(tag);
    if (refused) return refused;
    if (req.method === "PUT") {
      if (!state.tags.includes(tag)) state.tags = [...state.tags, tag].sort();
      return entity();
    }
    if (!state.tags.includes(tag)) return problem(404, "not found", `no tag ${tag}`);
    state.tags = state.tags.filter((t) => t !== tag);
    return new Response(null, { status: 204 });
  };
  const routes: Record<string, unknown> = { [base]: () => entity() };
  for (const t of ["backend", "api", "frontend", "Frontend", "q1", "bad%20tag", "-bad", "new"]) routes[`${base}/tags/${t}`] = tagRoute(decodeURIComponent(t));
  mockApi(routes);
  return state;
}

const chips = () => within(screen.getByRole("region", { name: "Tags" })).queryAllByRole("listitem").map((li) => li.textContent?.replace("×", "").trim());
const type = (value: string) => fireEvent.change(screen.getByLabelText("New tag"), { target: { value } });
const addButton = () => screen.getByRole("button", { name: "Add tag" }) as HTMLButtonElement;

describe("TagEditor", () => {
  it("shows the tags as links that filter the project's board", async () => {
    server("story", ["backend", "api"]);
    renderEditor();
    expect(await screen.findByRole("link", { name: "backend" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "backend" }).getAttribute("href")).toBe("/projects/3?tag=backend");
    expect(chips()).toEqual(["backend", "api"]);
  });

  it("says when there are no tags", async () => {
    server("story", []);
    renderEditor();
    expect(await screen.findByText("No tags yet.")).toBeTruthy();
  });

  it("adds a tag, clears the field and shows the server's normalized tag", async () => {
    const state = server("story", ["api"]);
    renderEditor();
    await screen.findByRole("link", { name: "api" });
    expect(addButton().disabled).toBe(true); // nothing typed

    type("  Frontend  ");
    expect(addButton().disabled).toBe(false);
    fireEvent.click(addButton());

    await waitFor(() => expect(chips()).toEqual(["api", "frontend"])); // lower-cased by the server
    expect(state.calls).toEqual(["PUT frontend"]);
    expect((screen.getByLabelText("New tag") as HTMLInputElement).value).toBe("");
  });

  it("does not submit blank input", async () => {
    const state = server("story", []);
    renderEditor();
    await screen.findByText("No tags yet.");
    type("   ");
    expect(addButton().disabled).toBe(true);
    fireEvent.submit(screen.getByRole("form", { name: "Add tag" }));
    expect(state.calls).toEqual([]);
  });

  it("removes a tag", async () => {
    const state = server("story", ["backend", "api"]);
    renderEditor();
    await screen.findByRole("link", { name: "backend" });
    fireEvent.click(screen.getByRole("button", { name: "Remove tag backend" }));
    await waitFor(() => expect(chips()).toEqual(["api"]));
    expect(state.calls).toEqual(["DELETE backend"]);
  });

  it("shows the server's message for an invalid tag, keeps the text, and dismisses it when typing", async () => {
    const state = server("story", [], (tag) => (tag.startsWith("-") ? problem(422, "validation failed", `invalid tag: "${tag}" (use 1-50 chars of a-z, 0-9)`) : undefined));
    renderEditor();
    await screen.findByText("No tags yet.");
    type("-bad");
    fireEvent.click(addButton());
    expect((await screen.findByRole("alert")).textContent).toContain("invalid tag");
    expect((screen.getByLabelText("New tag") as HTMLInputElement).value).toBe("-bad");
    expect(state.tags).toEqual([]);
    type("new");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the server's message when a removal fails", async () => {
    server("story", ["backend"], () => problem(500, "internal error", "database is on fire"));
    renderEditor();
    await screen.findByRole("link", { name: "backend" });
    fireEvent.click(screen.getByRole("button", { name: "Remove tag backend" }));
    expect((await screen.findByRole("alert")).textContent).toContain("database is on fire");
    expect(chips()).toEqual(["backend"]);
  });

  it("works the same for epics", async () => {
    const state = server("epic", ["q1"]);
    renderEditor("epic");
    await screen.findByRole("link", { name: "q1" });
    type("new");
    fireEvent.click(addButton());
    await waitFor(() => expect(chips()).toEqual(["new", "q1"]));
    fireEvent.click(screen.getByRole("button", { name: "Remove tag q1" }));
    await waitFor(() => expect(chips()).toEqual(["new"]));
    expect(state.calls).toEqual(["PUT new", "DELETE q1"]);
  });

  it("refreshes what shows the tags: the story, its epic's list and the project's board", async () => {
    server("story", []);
    const { invalidate } = renderEditor("story");
    await screen.findByText("No tags yet.");
    type("new");
    fireEvent.click(addButton());
    await waitFor(() => expect(chips()).toEqual(["new"]));
    const keys = invalidate.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toEqual(expect.arrayContaining(['["story",1]', '["epic",2]', '["project",3]']));
  });

  it("refreshes the epic and its project for an epic's tags", async () => {
    server("epic", []);
    const { invalidate } = renderEditor("epic");
    await screen.findByText("No tags yet.");
    type("new");
    fireEvent.click(addButton());
    await waitFor(() => expect(chips()).toEqual(["new"]));
    const keys = invalidate.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toEqual(expect.arrayContaining(['["epic",1]', '["project",3]']));
  });
});
