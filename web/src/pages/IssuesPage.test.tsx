import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import IssuesPage from "./IssuesPage";
import { issue, json, mockApi, problem, project, story, type Issue } from "../test/fixtures";

const stories = [
  story({ id: 1, epic_id: 1, project_id: 1, name: "Login", state: "implementation" }),
  story({ id: 2, epic_id: 1, project_id: 1, name: "Sessions", state: "finished" }),
  story({ id: 3, epic_id: 1, project_id: 1, name: "Old idea", state: "cancelled" }),
];

interface Setup {
  issues?: Issue[];
  /** Answer a write with this instead of applying it. */
  refuse?: (method: string, body: Record<string, unknown> | null) => Response | undefined;
}

/** A small stateful fake of the project's issue endpoints. */
function setup(init: Setup = {}) {
  const w = { issues: init.issues ?? [], writes: [] as { method: string; path: string; body: Record<string, unknown> | null }[] };
  const issueRoutes = Object.fromEntries(
    [1, 2, 3, 4, 5].map((n) => [
      `/api/v1/issues/${n}`,
      async (req: Request) => {
        const body = req.method === "DELETE" ? null : ((await req.json()) as Record<string, unknown>);
        w.writes.push({ method: req.method, path: `/issues/${n}`, body });
        const refused = init.refuse?.(req.method, body);
        if (refused) return refused;
        if (req.method === "DELETE") {
          w.issues = w.issues.filter((i) => i.id !== n);
          return new Response(null, { status: 204 });
        }
        w.issues = w.issues.map((i) => (i.id === n ? { ...i, ...(body as Partial<Issue>) } : i));
        return w.issues.find((i) => i.id === n)!;
      },
    ]),
  );
  const server = mockApi({
    ...issueRoutes,
    "/api/v1/projects/1": project({ id: 1, name: "Alpha" }),
    "/api/v1/projects/1/stories": stories,
    "/api/v1/projects/1/issues": async (req: Request) => {
      if (req.method === "GET") return w.issues;
      const body = (await req.json()) as Record<string, unknown>;
      w.writes.push({ method: "POST", path: "/projects/1/issues", body });
      const refused = init.refuse?.("POST", body);
      if (refused) return refused;
      const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(String(body.github_url));
      const created = issue({ id: Math.max(0, ...w.issues.map((i) => i.id)) + 1, github_url: String(body.github_url), github_repo: m ? `${m[1]}/${m[2]}`.toLowerCase() : "x/y", number: m ? Number(m[3]) : 1, title: String(body.title ?? ""), kind: String(body.kind ?? ""), story_id: (body.story_id as number | null) ?? null });
      w.issues = [...w.issues, created];
      return json(created, 201);
    },
  });
  return { w, ...server };
}

function LocationProbe() {
  const l = useLocation();
  return <span data-testid="location">{l.pathname + l.search}</span>;
}

function renderAt(url = "/projects/1/issues") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/projects/:projectId/issues" element={<IssuesPage />} />
          <Route path="/projects/:projectId" element={<p>project page</p>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { invalidate };
}

const loaded = () => screen.findByRole("heading", { name: "Issues" });
const location = () => screen.getByTestId("location").textContent;
const cards = () => Array.from(document.querySelectorAll(".cards .card")).map((c) => c.textContent ?? "");

const first = issue({ id: 1, github_url: "https://github.com/acme/widgets/issues/42", github_repo: "acme/widgets", number: 42, title: "Crash on save", kind: "bug", story_id: 1, created_at: "2026-01-02T03:04:05.000Z" });
const second = issue({ id: 2, github_url: "https://github.com/acme/widgets/issues/43", github_repo: "acme/widgets", number: 43, title: "", kind: "", story_id: null, created_at: "2026-01-03T10:00:00.000Z" });

describe("IssuesPage list", () => {
  it("lists the issues newest first with their GitHub link, title, kind and story", async () => {
    setup({ issues: [first, second] });
    renderAt();
    await loaded();
    await screen.findByText(/acme\/widgets#42/);

    const [newest, oldest] = cards();
    expect(newest).toContain("acme/widgets#43");
    expect(newest).toContain("Not linked to a story");
    expect(newest).toContain("2026-01-03 10:00 UTC");
    expect(oldest).toContain("acme/widgets#42");
    expect(oldest).toContain("Crash on save");
    expect(oldest).toContain("bug");
    expect(oldest).toContain("#1 Login");

    const link = screen.getByRole("link", { name: "acme/widgets#42" });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/widgets/issues/42"); // GitHub, in a new tab
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(screen.getByRole("link", { name: "#1 Login" }).getAttribute("href")).toBe("/stories/1");
    expect(screen.getByRole("link", { name: /Alpha/ }).getAttribute("href")).toBe("/projects/1");
  });

  it("says when there are no issues", async () => {
    setup();
    renderAt();
    expect(await screen.findByText("This project has no issues yet.")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Issue filter" })).toBeNull();
  });
});

describe("IssuesPage filter", () => {
  it("filters by story and by 'not linked', through the URL", async () => {
    setup({ issues: [first, second] });
    renderAt("/projects/1/issues?story=1");
    await loaded();
    await screen.findByText(/acme\/widgets#42/);
    expect(cards()).toHaveLength(1);
    expect((screen.getByLabelText("Story") as HTMLSelectElement).value).toBe("1");

    fireEvent.change(screen.getByLabelText("Story"), { target: { value: "none" } });
    await waitFor(() => expect(location()).toBe("/projects/1/issues?story=none"));
    expect(cards()).toHaveLength(1);
    expect(cards()[0]).toContain("#43");

    fireEvent.change(screen.getByLabelText("Story"), { target: { value: "" } });
    await waitFor(() => expect(location()).toBe("/projects/1/issues"));
    expect(cards()).toHaveLength(2);
  });

  it("ignores a filter that matches no story, and explains an empty result", async () => {
    setup({ issues: [second] });
    renderAt("/projects/1/issues?story=99");
    await loaded();
    await screen.findByText(/acme\/widgets#43/);
    expect(cards()).toHaveLength(1);
    expect((screen.getByLabelText("Story") as HTMLSelectElement).value).toBe(""); // falls back to "All issues"
  });

  it("offers a way back when the filter hides everything", async () => {
    setup({ issues: [first] });
    renderAt("/projects/1/issues?story=none");
    await loaded();
    expect(await screen.findByText(/No issues match the filter/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show all issues" }));
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(location()).toBe("/projects/1/issues");
  });

  it("offers every story of the project, finished and cancelled ones included", async () => {
    setup({ issues: [first] });
    renderAt();
    await loaded();
    await screen.findByText(/acme\/widgets#42/);
    const options = within(screen.getByLabelText("Story")).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["All issues", "Not linked to a story", "#1 Login", "#2 Sessions", "#3 Old idea"]);
  });
});

describe("IssuesPage adding", () => {
  it("adds an issue, linked to a story, and refreshes the list", async () => {
    const { w } = setup({ issues: [first] });
    const { invalidate } = renderAt();
    await loaded();
    await screen.findByText(/acme\/widgets#42/);

    expect(screen.queryByRole("form", { name: "Add issue" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add issue" }));
    const form = screen.getByRole("form", { name: "Add issue" });
    fireEvent.change(within(form).getByLabelText("GitHub issue URL"), { target: { value: "https://github.com/Acme/Gadgets/issues/9" } });
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Slow search" } });
    fireEvent.change(within(form).getByLabelText("Kind"), { target: { value: "defect" } });
    fireEvent.change(within(form).getByLabelText("Linked story"), { target: { value: "2" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add issue" }));

    await waitFor(() => expect(screen.queryByRole("form", { name: "Add issue" })).toBeNull());
    expect(w.writes).toEqual([{ method: "POST", path: "/projects/1/issues", body: { github_url: "https://github.com/Acme/Gadgets/issues/9", title: "Slow search", kind: "defect", story_id: 2 } }]);
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(cards()[0]).toContain("acme/gadgets#9");
    expect(cards()[0]).toContain("#2 Sessions"); // a finished story can still get an issue link
    const keys = invalidate.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toEqual(expect.arrayContaining(['["project",1]', '["story"]']));
  });

  it("sends no story when none is chosen", async () => {
    const { w } = setup();
    renderAt();
    await loaded();
    fireEvent.click(await screen.findByRole("button", { name: "Add issue" }));
    fireEvent.change(screen.getByLabelText("GitHub issue URL"), { target: { value: "https://github.com/acme/widgets/issues/5" } });
    fireEvent.click(within(screen.getByRole("form", { name: "Add issue" })).getByRole("button", { name: "Add issue" }));
    await waitFor(() => expect(w.writes).toHaveLength(1));
    expect(w.writes[0].body).toMatchObject({ story_id: null, title: "", kind: "" });
  });

  it("shows the server's message for a refused URL inside the form, keeps the text and dismisses it when typing", async () => {
    setup({ refuse: () => problem(422, "validation failed", "invalid GitHub issue URL: must be an https://github.com URL (expected https://github.com/{owner}/{repo}/issues/{number})") });
    renderAt();
    await loaded();
    fireEvent.click(await screen.findByRole("button", { name: "Add issue" }));
    const form = screen.getByRole("form", { name: "Add issue" });
    fireEvent.change(within(form).getByLabelText("GitHub issue URL"), { target: { value: "https://gitlab.com/a/b/issues/1" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add issue" }));

    expect((await within(form).findByRole("alert")).textContent).toContain("invalid GitHub issue URL");
    expect((within(form).getByLabelText("GitHub issue URL") as HTMLInputElement).value).toBe("https://gitlab.com/a/b/issues/1");
    fireEvent.change(within(form).getByLabelText("GitHub issue URL"), { target: { value: "https://github.com/a/b/issues/1" } });
    expect(within(form).queryByRole("alert")).toBeNull();
  });

  it("shows the server's message for a duplicate", async () => {
    setup({ issues: [first], refuse: () => problem(409, "conflict", "issue acme/widgets#42 in project 1: already exists") });
    renderAt();
    await loaded();
    fireEvent.click(await screen.findByRole("button", { name: "Add issue" }));
    fireEvent.change(screen.getByLabelText("GitHub issue URL"), { target: { value: first.github_url } });
    fireEvent.click(within(screen.getByRole("form", { name: "Add issue" })).getByRole("button", { name: "Add issue" }));
    expect((await screen.findByRole("alert")).textContent).toContain("already exists");
  });

  it("can be cancelled without sending anything", async () => {
    const { w } = setup();
    renderAt();
    await loaded();
    fireEvent.click(await screen.findByRole("button", { name: "Add issue" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Add issue" })).toBeNull();
    expect(w.writes).toHaveLength(0);
  });
});

describe("IssuesPage editing and removing", () => {
  it("edits title, kind and the story link, without a URL field", async () => {
    const { w } = setup({ issues: [first] });
    renderAt();
    await loaded();
    fireEvent.click(await screen.findByRole("button", { name: "Edit issue acme/widgets#42" }));

    const form = screen.getByRole("form", { name: "Edit issue" });
    expect(within(form).queryByLabelText("GitHub issue URL")).toBeNull(); // the URL cannot change
    expect((within(form).getByLabelText("Title") as HTMLInputElement).value).toBe("Crash on save");
    expect((within(form).getByLabelText("Linked story") as HTMLSelectElement).value).toBe("1");
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Crash on autosave" } });
    fireEvent.change(within(form).getByLabelText("Linked story"), { target: { value: "" } }); // unlink
    fireEvent.click(within(form).getByRole("button", { name: "Save issue" }));

    await waitFor(() => expect(screen.queryByRole("form", { name: "Edit issue" })).toBeNull());
    expect(w.writes).toEqual([{ method: "PATCH", path: "/issues/1", body: { title: "Crash on autosave", kind: "bug", story_id: null } }]);
    await waitFor(() => expect(cards()[0]).toContain("Crash on autosave"));
    expect(cards()[0]).toContain("Not linked to a story");
  });

  it("links an unlinked issue to a story", async () => {
    const { w } = setup({ issues: [second] });
    renderAt();
    await loaded();
    fireEvent.click(await screen.findByRole("button", { name: "Edit issue acme/widgets#43" }));
    fireEvent.change(screen.getByLabelText("Linked story"), { target: { value: "3" } }); // a cancelled story is fine
    fireEvent.click(screen.getByRole("button", { name: "Save issue" }));
    await waitFor(() => expect(w.writes[0]?.body).toMatchObject({ story_id: 3 }));
    await waitFor(() => expect(cards()[0]).toContain("#3 Old idea"));
  });

  it("shows the server's message when saving is refused", async () => {
    setup({ issues: [first], refuse: () => problem(422, "validation failed", "story 9: referenced record does not exist") });
    renderAt();
    await loaded();
    fireEvent.click(await screen.findByRole("button", { name: "Edit issue acme/widgets#42" }));
    fireEvent.click(screen.getByRole("button", { name: "Save issue" }));
    expect((await screen.findByRole("alert")).textContent).toContain("does not exist");
    expect(screen.getByRole("form", { name: "Edit issue" })).toBeTruthy();
  });

  it("removes an issue", async () => {
    const { w } = setup({ issues: [first, second] });
    renderAt();
    await loaded();
    fireEvent.click(await screen.findByRole("button", { name: "Remove issue acme/widgets#42" }));
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(w.writes).toEqual([{ method: "DELETE", path: "/issues/1", body: null }]);
    expect(cards()[0]).toContain("#43");
  });

  it("shows the server's message when removing fails", async () => {
    setup({ issues: [first], refuse: () => problem(500, "internal error", "database is on fire") });
    renderAt();
    await loaded();
    fireEvent.click(await screen.findByRole("button", { name: "Remove issue acme/widgets#42" }));
    expect((await screen.findByRole("alert")).textContent).toContain("database is on fire");
    expect(cards()).toHaveLength(1);
  });
});

describe("IssuesPage errors", () => {
  it("reports an unknown project", async () => {
    mockApi({
      "/api/v1/projects/9": problem(404, "not found", "x"),
      "/api/v1/projects/9/issues": problem(404, "not found", "x"),
      "/api/v1/projects/9/stories": problem(404, "not found", "x"),
    });
    renderAt("/projects/9/issues");
    expect(await screen.findByRole("heading", { name: "Project not found" })).toBeTruthy();
  });

  it("treats a malformed id as unknown without calling the API", () => {
    const { calls } = setup();
    renderAt("/projects/abc/issues");
    expect(screen.getByRole("heading", { name: "Project not found" })).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("shows server errors and recovers on retry", async () => {
    let healthy = false;
    mockApi({
      "/api/v1/projects/1": project({ id: 1, name: "Alpha" }),
      "/api/v1/projects/1/stories": stories,
      "/api/v1/projects/1/issues": () => (healthy ? [] : problem(500, "internal error", "database is on fire")),
    });
    renderAt();
    expect((await screen.findByRole("alert")).textContent).toContain("database is on fire");
    healthy = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await loaded()).toBeTruthy();
  });

  it("shows a loading message first", async () => {
    setup();
    renderAt();
    expect(screen.getByText("Loading...")).toBeTruthy();
    await loaded();
  });
});
