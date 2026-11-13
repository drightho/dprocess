import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import IssuesPage from "./IssuesPage";
import { epic, issue, json, mockApi, problem, project, story, type Epic, type Issue } from "../test/fixtures";

const stories = [
  story({ id: 1, epic_id: 1, project_id: 1, name: "Login", state: "implementation" }),
  story({ id: 2, epic_id: 1, project_id: 1, name: "Sessions", state: "finished" }),
  story({ id: 3, epic_id: 1, project_id: 1, name: "Old idea", state: "cancelled" }),
];

interface Setup {
  issues?: Issue[];
  /** The project's epics (GET /projects/1/epics); none by default. */
  epics?: Epic[];
  /** Answer POST /epics/{id}/stories with this instead of creating the story. */
  refuseStory?: (body: Record<string, unknown>) => Response | undefined;
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
  const storyRoutes = Object.fromEntries(
    [1, 2, 3, 4].map((n) => [
      `/api/v1/epics/${n}/stories`,
      async (req: Request) => {
        const body = (await req.json()) as Record<string, unknown>;
        w.writes.push({ method: req.method, path: `/epics/${n}/stories`, body });
        const refused = init.refuseStory?.(body);
        if (refused) return refused;
        return json(story({ id: 10, epic_id: n, project_id: 1, name: String(body.name), description: String(body.description ?? "") }), 201);
      },
    ]),
  );
  const server = mockApi({
    ...issueRoutes,
    ...storyRoutes,
    "/api/v1/projects/1/epics": init.epics ?? [],
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
          <Route path="/stories/:storyId" element={<p>story page</p>} />
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

describe("IssuesPage repo_mismatch badge", () => {
  const MSG = "Different repository than the project's linked repository";

  it("marks only the issue cards whose warnings contain repo_mismatch", async () => {
    setup({ issues: [{ ...first, warnings: ["repo_mismatch"] }, { ...second, warnings: [] }] });
    renderAt();
    await loaded();
    await screen.findByText(/acme\/widgets#42/);

    const badge = screen.getByLabelText(MSG);
    expect(badge.textContent).toBe("other repo");
    expect(badge.getAttribute("title")).toBe(MSG);
    expect(screen.getAllByLabelText(MSG)).toHaveLength(1);
    const [newest, oldest] = Array.from(document.querySelectorAll(".cards .card"));
    expect(oldest.contains(badge)).toBe(true);
    expect(newest.textContent).not.toContain("other repo");
  });

  it("shows no badge for empty or unknown warning codes", async () => {
    setup({ issues: [{ ...first, warnings: [] }, { ...second, warnings: ["estimate_exceeds_400_loc", "brand_new_code"] }] });
    renderAt();
    await loaded();
    await screen.findByText(/acme\/widgets#42/);
    expect(screen.queryByLabelText(MSG)).toBeNull();
    expect(screen.queryByText("other repo")).toBeNull();
  });
});

describe("IssuesPage creating a story from an issue", () => {
  const epics = [
    epic({ id: 1, name: "Auth", state: "ready" }),
    epic({ id: 2, name: "Done work", state: "finished" }),
    epic({ id: 3, name: "Billing", state: "draft" }),
    epic({ id: 4, name: "Dropped", state: "cancelled" }),
  ];
  const unlinked = issue({ id: 2, github_url: "https://github.com/acme/widgets/issues/43", number: 43, title: "Slow search", story_id: null });
  const linkedElsewhere = issue({ id: 3, github_url: "https://github.com/acme/widgets/issues/44", number: 44, title: "Ghost", story_id: 99 }); // a story not in the list
  const createButton = (label: string) => screen.queryByRole("button", { name: `Create story from issue ${label}` }) as HTMLButtonElement | null;
  const cardOf = (label: string) => screen.getByRole("link", { name: label }).closest(".card") as HTMLElement;
  const createForm = () => screen.getByRole("form", { name: "Create story" });
  const invalidatedKeys = (invalidate: ReturnType<typeof renderAt>["invalidate"]) =>
    invalidate.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));

  /** Waits until the epics have loaded and the action for this issue can be used, then opens the form. */
  async function openCreate(label = "acme/widgets#43") {
    await loaded();
    await waitFor(() => expect(createButton(label)?.disabled).toBe(false));
    fireEvent.click(createButton(label)!);
    return createForm();
  }

  it("offers 'Create story' only on cards that are not linked to a story", async () => {
    setup({ issues: [first, unlinked, linkedElsewhere], epics });
    renderAt();
    await loaded();
    await waitFor(() => expect(createButton("acme/widgets#43")?.disabled).toBe(false));

    expect(createButton("acme/widgets#43")!.textContent).toBe("Create story");
    expect(cardOf("acme/widgets#43").contains(createButton("acme/widgets#43"))).toBe(true);
    expect(createButton("acme/widgets#42")).toBeNull(); // linked to story 1
    expect(createButton("acme/widgets#44")).toBeNull(); // has a story_id, even an unknown one
    expect(within(cardOf("acme/widgets#42")).queryByText("Create story")).toBeNull();
    expect(screen.queryByRole("form", { name: "Create story" })).toBeNull(); // nothing open until asked
  });

  it("opens an inline form: only open epics, the issue's title as name, an empty description", async () => {
    setup({ issues: [first, unlinked], epics });
    renderAt();
    const form = await openCreate();

    expect(form.closest(".card")).not.toBeNull(); // inline, on the card
    const select = within(form).getByLabelText("Epic") as HTMLSelectElement;
    const options = within(select).getAllByRole("option") as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual(["", "1", "3"]); // finished and cancelled epics are left out
    expect(options.slice(1).map((o) => o.textContent)).toEqual(["#1 Auth", "#3 Billing"]);
    expect(select.value).toBe(""); // no epic chosen yet

    const name = within(form).getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("Slow search");
    fireEvent.change(name, { target: { value: "Speed up search" } });
    expect(name.value).toBe("Speed up search"); // editable
    expect((within(form).getByLabelText("Description") as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps 'Create story' disabled until an epic is chosen", async () => {
    const { w } = setup({ issues: [unlinked], epics });
    renderAt();
    const form = await openCreate();
    const submit = within(form).getByRole("button", { name: "Create story" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Epic"), { target: { value: "1" } });
    expect(submit.disabled).toBe(false);
    fireEvent.change(within(form).getByLabelText("Epic"), { target: { value: "" } });
    expect(submit.disabled).toBe(true);
    expect(w.writes).toHaveLength(0);
  });

  it.each([
    ["only finished and cancelled epics", [epic({ id: 2, state: "finished" }), epic({ id: 4, state: "cancelled" })]],
    ["no epics at all", []],
  ])("disables the action with a hint when the project has %s", async (_what, closed) => {
    setup({ issues: [unlinked], epics: closed });
    renderAt();
    await loaded();
    await waitFor(() => expect(cardOf("acme/widgets#43").textContent).toContain("no open epic; create one first"));
    const button = createButton("acme/widgets#43")!;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByRole("form", { name: "Create story" })).toBeNull();
  });

  it("creates the story, links the issue to it, refreshes and goes to the new story", async () => {
    const { w } = setup({ issues: [unlinked], epics });
    const { invalidate } = renderAt();
    const form = await openCreate();
    fireEvent.change(within(form).getByLabelText("Epic"), { target: { value: "3" } });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Speed up search" } });
    fireEvent.change(within(form).getByLabelText("Description"), { target: { value: "Index the titles." } });
    fireEvent.click(within(form).getByRole("button", { name: "Create story" }));

    await waitFor(() => expect(location()).toBe("/stories/10"));
    expect(w.writes).toEqual([
      { method: "POST", path: "/epics/3/stories", body: { name: "Speed up search", description: "Index the titles." } },
      { method: "PATCH", path: "/issues/2", body: { story_id: 10 } },
    ]);
    expect(w.issues.find((i) => i.id === 2)!.story_id).toBe(10); // the story now lists the issue
    expect(invalidatedKeys(invalidate)).toEqual(expect.arrayContaining(['["project",1]', '["epic",3]', '["story",10]']));
  });

  it("sends the title unchanged and an empty description when nothing is edited", async () => {
    const { w } = setup({ issues: [unlinked], epics });
    renderAt();
    const form = await openCreate();
    fireEvent.change(within(form).getByLabelText("Epic"), { target: { value: "1" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create story" }));
    await waitFor(() => expect(location()).toBe("/stories/10"));
    expect(w.writes[0]).toEqual({ method: "POST", path: "/epics/1/stories", body: { name: "Slow search", description: "" } });
  });

  it("shows the server's message in the form when the epic is closed, and links nothing", async () => {
    const { w } = setup({ issues: [unlinked], epics, refuseStory: () => problem(409, "conflict", "epic 1 is finished: cannot add stories") });
    renderAt();
    const form = await openCreate();
    fireEvent.change(within(form).getByLabelText("Epic"), { target: { value: "1" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create story" }));

    expect((await within(form).findByRole("alert")).textContent).toBe("epic 1 is finished: cannot add stories");
    expect(screen.getByRole("form", { name: "Create story" })).toBe(form); // still open
    expect(w.writes).toEqual([{ method: "POST", path: "/epics/1/stories", body: { name: "Slow search", description: "" } }]); // no PATCH
    expect(location()).toBe("/projects/1/issues");
    expect(w.issues[0].story_id).toBeNull();
  });

  it("sends an empty name as typed and shows the server's 422 verbatim", async () => {
    const untitled = issue({ ...unlinked, title: "" });
    const { w } = setup({ issues: [untitled], epics, refuseStory: () => problem(422, "validation failed", "name: must not be empty") });
    renderAt();
    const form = await openCreate();
    expect((within(form).getByLabelText("Name") as HTMLInputElement).value).toBe("");
    fireEvent.change(within(form).getByLabelText("Epic"), { target: { value: "3" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create story" })); // no client-side name check

    expect((await within(form).findByRole("alert")).textContent).toBe("name: must not be empty");
    expect(w.writes).toEqual([{ method: "POST", path: "/epics/3/stories", body: { name: "", description: "" } }]);
    expect(location()).toBe("/projects/1/issues");
  });

  it("keeps the new story when linking fails: closes the form, shows the message and a link to the story on the card", async () => {
    const { w, fetchMock } = setup({ issues: [unlinked], epics, refuse: (method) => (method === "PATCH" ? problem(500, "internal error", "database is on fire") : undefined) });
    const { invalidate } = renderAt();
    const form = await openCreate();
    fireEvent.change(within(form).getByLabelText("Epic"), { target: { value: "1" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create story" }));

    await waitFor(() => expect(screen.queryByRole("form", { name: "Create story" })).toBeNull()); // closed: no resubmit
    const card = cardOf("acme/widgets#43");
    expect((await within(card).findByRole("alert")).textContent).toContain("database is on fire");
    const storyLinks = within(card).getAllByRole("link").filter((a) => a.getAttribute("href") === "/stories/10");
    expect(storyLinks).toHaveLength(1);

    expect(location()).toBe("/projects/1/issues");
    expect(w.writes.map((x) => `${x.method} ${x.path}`)).toEqual(["POST /epics/1/stories", "PATCH /issues/2"]); // one POST, nothing deleted
    expect(fetchMock.mock.calls.some(([req]) => (req as Request).method === "DELETE")).toBe(false);
    expect(w.issues[0].story_id).toBeNull();
    expect(card.textContent).toContain("Not linked to a story");
    expect(invalidatedKeys(invalidate)).toContain('["project",1]');
  });

  it("can be cancelled without sending anything", async () => {
    const { w } = setup({ issues: [unlinked], epics });
    renderAt();
    const form = await openCreate();
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Create story" })).toBeNull();
    expect(w.writes).toHaveLength(0);
    expect(createButton("acme/widgets#43")).not.toBeNull(); // the action is back
  });

  it("never shows the create and edit forms on one card at once", async () => {
    setup({ issues: [unlinked], epics });
    renderAt();
    await openCreate();
    const edit = screen.queryByRole("button", { name: "Edit issue acme/widgets#43" });
    if (edit) fireEvent.click(edit);
    const open = () => screen.queryAllByRole("form").filter((f) => ["Create story", "Edit issue"].includes(f.getAttribute("aria-label") ?? ""));
    expect(open()).toHaveLength(1);

    // And the other way round: while editing, there is no create action.
    const other = screen.queryByRole("form", { name: "Edit issue" });
    if (!other) fireEvent.click(within(createForm()).getByRole("button", { name: "Cancel" }));
    if (!screen.queryByRole("form", { name: "Edit issue" })) fireEvent.click(screen.getByRole("button", { name: "Edit issue acme/widgets#43" }));
    expect(screen.getByRole("form", { name: "Edit issue" })).toBeTruthy();
    expect(createButton("acme/widgets#43")).toBeNull();
    expect(open()).toHaveLength(1);
  });
});
