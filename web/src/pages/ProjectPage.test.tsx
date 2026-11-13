import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import ProjectPage from "./ProjectPage";
import { LANE_LIMIT } from "../lib/board";
import { RECENT_KEY, readRecent } from "../lib/recent";
import { epic, json, mockApi, problem, story } from "../test/fixtures";

const project = {
  id: 1,
  name: "Alpha",
  description: "The first project",
  github_repo_url: "",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
const epics = [
  epic({ id: 1, name: "Auth", state: "ready", tags: ["q1"] }),
  epic({ id: 2, name: "Billing", state: "draft" }),
];
const stories = [
  story({ id: 1, epic_id: 1, name: "Login", state: "finished", assignee: "ann", tags: ["backend", "api"], estimate_loc: 120 }),
  story({ id: 2, epic_id: 1, name: "Logout", state: "implementation", assignee: "ann", tags: ["backend"] }),
  story({ id: 3, epic_id: 2, name: "Invoice list", state: "draft", assignee: "bob", tags: ["frontend"], estimate_loc: 450, warnings: ["estimate_exceeds_400_loc"] }),
  story({ id: 4, epic_id: 2, name: "Old idea", state: "cancelled" }),
];
const fullRoutes = {
  "/api/v1/projects/1": project,
  "/api/v1/projects/1/epics": epics,
  "/api/v1/projects/1/stories": stories,
};

function LocationProbe() {
  const l = useLocation();
  return <span data-testid="location">{l.pathname + l.search}</span>;
}

function renderAt(url: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/projects/:projectId" element={<ProjectPage />} />
          <Route path="/" element={<p>landing</p>} />
          <Route path="/epics/:epicId" element={<p>epic page</p>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const column = (state: string) => screen.getByRole("region", { name: `${state} stories` });
const regionLabels = () => screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
const location = () => screen.getByTestId("location").textContent;
/** Names of the story cards currently on the board, in column order. */
const cardNames = () =>
  Array.from(document.querySelectorAll(".board .card strong")).map((el) => el.textContent);

afterEach(() => vi.unstubAllGlobals());

describe("ProjectPage overview", () => {
  it("shows the project, its epics with progress, and the board by state", async () => {
    mockApi(fullRoutes);
    renderAt("/projects/1");

    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByText("The first project")).toBeTruthy();

    const auth = screen.getByRole("button", { name: /^Auth/ });
    expect(auth.textContent).toContain("ready");
    expect(auth.textContent).toContain("1 of 2 stories finished");
    expect(auth.textContent).toContain("q1");
    const billing = screen.getByRole("button", { name: /^Billing/ });
    expect(billing.textContent).toContain("draft");
    expect(billing.textContent).toContain("0 of 2 stories finished, 1 cancelled");

    // Only states that have stories get a column, in workflow order, each with its count.
    expect(regionLabels()).toEqual([
      "draft stories", "implementation stories", "finished stories", "cancelled stories",
    ]);
    expect(within(column("implementation")).getByText("Logout")).toBeTruthy();
    expect(within(column("finished")).getByText("Login")).toBeTruthy();
    expect(within(column("cancelled")).getByText("Old idea")).toBeTruthy();
    expect(within(column("implementation")).getByLabelText("1 story")).toBeTruthy();
    expect(within(column("draft")).getByLabelText("1 story")).toBeTruthy();

    // Card details: epic, assignee, size, tags, and the over-400 warning.
    const invoice = screen.getByText("Invoice list").closest("li")!;
    expect(invoice.textContent).toContain("#3");
    expect(invoice.textContent).toContain("Billing");
    expect(invoice.textContent).toContain("bob");
    expect(invoice.textContent).toContain("450 LOC");
    expect(invoice.textContent).toContain("Estimate is over 400 lines");
    expect(screen.getByText("Old idea").closest("li")!.textContent).toContain("unassigned");
    expect(screen.getByText("Login").closest("li")!.textContent).not.toContain("over 400");
  });

  it("links back to the list of all projects", async () => {
    mockApi(fullRoutes);
    renderAt("/projects/1");
    const back = await screen.findByRole("link", { name: /All projects/ });
    expect(back.getAttribute("href")).toBe("/projects");
  });

  it("links to the project's issues", async () => {
    mockApi(fullRoutes);
    renderAt("/projects/1");
    await screen.findByRole("heading", { name: "Alpha" });
    expect(screen.getByRole("link", { name: "Issues" }).getAttribute("href")).toBe("/projects/1/issues");
  });

  it("links each epic, and each story card's epic name, to the epic page", async () => {
    mockApi(fullRoutes);
    renderAt("/projects/1");
    await screen.findByRole("heading", { name: "Alpha" });
    const open = screen.getAllByRole("link", { name: /Open epic/ }).map((a) => a.getAttribute("href"));
    expect(open).toEqual(["/epics/1", "/epics/2"]);
    const invoice = screen.getByText("Invoice list").closest("li")!;
    expect(within(invoice).getByRole("link", { name: "Billing" }).getAttribute("href")).toBe("/epics/2");
  });

  it("links each story card to the story page", async () => {
    mockApi(fullRoutes);
    renderAt("/projects/1");
    await screen.findByRole("heading", { name: "Alpha" });
    expect(screen.getByRole("link", { name: "Invoice list" }).getAttribute("href")).toBe("/stories/3");
  });

  it("requests the project, its epics and its stories once each", async () => {
    const { calls } = mockApi(fullRoutes);
    renderAt("/projects/1");
    await screen.findByRole("heading", { name: "Alpha" });
    expect([...calls].sort()).toEqual([
      "/api/v1/projects/1", "/api/v1/projects/1/epics", "/api/v1/projects/1/stories",
    ]);
  });
});

describe("ProjectPage filters", () => {
  it("applies the filters found in the URL (so a reload keeps them)", async () => {
    mockApi(fullRoutes);
    renderAt("/projects/1?epic=1&tag=backend");
    await screen.findByRole("heading", { name: "Alpha" });

    expect(cardNames()).toEqual(["Logout", "Login"]); // column order: implementation, then finished
    expect((screen.getByLabelText("Epic") as HTMLSelectElement).value).toBe("1");
    expect((screen.getByLabelText("Tag") as HTMLSelectElement).value).toBe("backend");
    expect((screen.getByLabelText("Assignee") as HTMLSelectElement).value).toBe("");
    expect(screen.getByRole("button", { name: /^Auth/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^Billing/ }).getAttribute("aria-pressed")).toBe("false");
  });

  it("filters by assignee, by tag and by epic, and writes them to the URL", async () => {
    mockApi(fullRoutes);
    renderAt("/projects/1");
    await screen.findByRole("heading", { name: "Alpha" });
    expect(cardNames()).toEqual(["Invoice list", "Logout", "Login", "Old idea"]); // board order

    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "bob" } });
    expect(cardNames()).toEqual(["Invoice list"]);
    expect(location()).toBe("/projects/1?assignee=bob");

    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Tag"), { target: { value: "backend" } });
    expect(cardNames()).toEqual(["Logout", "Login"]);
    expect(location()).toBe("/projects/1?tag=backend");

    fireEvent.change(screen.getByLabelText("Epic"), { target: { value: "2" } });
    expect(location()).toBe("/projects/1?epic=2&tag=backend"); // AND of the two
    expect(screen.getByText("No stories match the filters.")).toBeTruthy();
  });

  it("offers only assignees and tags that exist in the project", async () => {
    mockApi(fullRoutes);
    renderAt("/projects/1");
    await screen.findByRole("heading", { name: "Alpha" });
    const options = (label: string) =>
      within(screen.getByLabelText(label)).getAllByRole("option").map((o) => o.textContent);
    expect(options("Assignee")).toEqual(["Anyone", "ann", "bob"]);
    expect(options("Tag")).toEqual(["Any tag", "api", "backend", "frontend"]);
    expect(options("Epic")).toEqual(["All epics", "Auth", "Billing"]);
  });

  it("filters the board when a tag chip on a card is clicked", async () => {
    mockApi(fullRoutes);
    renderAt("/projects/1");
    await screen.findByRole("heading", { name: "Alpha" });
    const chip = within(screen.getByText("Invoice list").closest("li")!).getByRole("link", { name: "frontend" });
    expect(chip.getAttribute("href")).toBe("/projects/1?tag=frontend");
    fireEvent.click(chip);
    await waitFor(() => expect(location()).toBe("/projects/1?tag=frontend"));
    expect(cardNames()).toEqual(["Invoice list"]);
    expect((screen.getByLabelText("Tag") as HTMLSelectElement).value).toBe("frontend");
  });

  it("toggles the epic filter by clicking an epic", async () => {
    mockApi(fullRoutes);
    renderAt("/projects/1");
    await screen.findByRole("heading", { name: "Alpha" });

    fireEvent.click(screen.getByRole("button", { name: /^Billing/ }));
    expect(cardNames()).toEqual(["Invoice list", "Old idea"]);
    expect(location()).toBe("/projects/1?epic=2");
    expect((screen.getByLabelText("Epic") as HTMLSelectElement).value).toBe("2");

    fireEvent.click(screen.getByRole("button", { name: /^Billing/ }));
    expect(cardNames()).toHaveLength(4);
    expect(location()).toBe("/projects/1");
  });

  it("ignores filter values that match nothing", async () => {
    mockApi(fullRoutes);
    renderAt("/projects/1?epic=99&assignee=zed&tag=nope");
    await screen.findByRole("heading", { name: "Alpha" });
    expect(cardNames()).toHaveLength(4);
    expect((screen.getByLabelText("Epic") as HTMLSelectElement).value).toBe("");
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("explains an empty result and clears the filters", async () => {
    mockApi(fullRoutes);
    renderAt("/projects/1?assignee=ann&tag=frontend"); // ann has no frontend stories
    await screen.findByRole("heading", { name: "Alpha" });

    expect(screen.getByText("No stories match the filters.")).toBeTruthy();
    expect(screen.queryAllByRole("region")).toHaveLength(0);
    const clear = screen.getAllByRole("button", { name: "Clear filters" });
    fireEvent.click(clear[clear.length - 1]);

    expect(cardNames()).toHaveLength(4);
    expect(location()).toBe("/projects/1");
  });
});

describe("ProjectPage empty and error states", () => {
  it("says so when the project has no epics and no stories", async () => {
    mockApi({ ...fullRoutes, "/api/v1/projects/1/epics": [], "/api/v1/projects/1/stories": [] });
    renderAt("/projects/1");
    expect(await screen.findByText("This project has no epics yet.")).toBeTruthy();
    expect(screen.getByText("This project has no stories yet.")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Story filters" })).toBeNull();
    expect(screen.queryAllByRole("region")).toHaveLength(0);
  });

  it("shows epics that have no stories", async () => {
    mockApi({ ...fullRoutes, "/api/v1/projects/1/stories": [] });
    renderAt("/projects/1");
    expect(await screen.findByRole("button", { name: /^Auth/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Auth/ }).textContent).toContain("No stories");
    expect(screen.getByText("This project has no stories yet.")).toBeTruthy();
  });

  it("shows a loading message first", async () => {
    mockApi(fullRoutes);
    renderAt("/projects/1");
    expect(screen.getByText("Loading...")).toBeTruthy();
    await screen.findByRole("heading", { name: "Alpha" });
  });

  it("reports an unknown project", async () => {
    mockApi({
      "/api/v1/projects/9": problem(404, "not found", "project 9: not found"),
      "/api/v1/projects/9/epics": problem(404, "not found", "project 9: not found"),
      "/api/v1/projects/9/stories": problem(404, "not found", "project 9: not found"),
    });
    renderAt("/projects/9");
    expect(await screen.findByRole("heading", { name: "Project not found" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to projects" }).getAttribute("href")).toBe("/");
  });

  it("treats a malformed id as unknown without calling the API", () => {
    const { calls } = mockApi(fullRoutes);
    for (const bad of ["abc", "0", "1x"]) {
      const { unmount } = renderAt(`/projects/${bad}`);
      expect(screen.getByRole("heading", { name: "Project not found" })).toBeTruthy();
      unmount();
    }
    expect(calls).toEqual([]);
  });

  it("shows server errors and recovers on retry", async () => {
    let healthy = false;
    mockApi({
      "/api/v1/projects/1": () => (healthy ? project : problem(500, "internal error", "database is on fire")),
      "/api/v1/projects/1/epics": epics,
      "/api/v1/projects/1/stories": stories,
    });
    renderAt("/projects/1");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("database is on fire");

    healthy = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("shows a failure to reach the server", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ title: "bad gateway", status: 502, detail: "upstream down" }, 502)));
    renderAt("/projects/1");
    expect((await screen.findByRole("alert")).textContent).toContain("upstream down");
  });
});

describe("ProjectPage visit tracking", () => {
  it("records a visit once the project has loaded", async () => {
    mockApi(fullRoutes);
    renderAt("/projects/1");
    await screen.findByRole("heading", { name: "Alpha" });
    await waitFor(() => expect(readRecent().map((r) => [r.id, r.name])).toEqual([[1, "Alpha"]]));
    expect(JSON.parse(localStorage.getItem(RECENT_KEY)!)[0].visitedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("moves the project to the top, without a duplicate, and refreshes its name", async () => {
    localStorage.setItem(
      RECENT_KEY,
      JSON.stringify([
        { id: 2, name: "Other", visitedAt: "2026-01-02T00:00:00.000Z" },
        { id: 1, name: "Old name", visitedAt: "2026-01-01T00:00:00.000Z" },
      ]),
    );
    mockApi(fullRoutes);
    renderAt("/projects/1");
    await screen.findByRole("heading", { name: "Alpha" });
    await waitFor(() => expect(readRecent().map((r) => [r.id, r.name])).toEqual([[1, "Alpha"], [2, "Other"]]));
  });

  it("does not record an unknown or malformed project", async () => {
    mockApi({
      "/api/v1/projects/9": problem(404, "not found", "project 9: not found"),
      "/api/v1/projects/9/epics": problem(404, "not found", "x"),
      "/api/v1/projects/9/stories": problem(404, "not found", "x"),
    });
    const { unmount } = renderAt("/projects/9");
    await screen.findByRole("heading", { name: "Project not found" });
    unmount();
    renderAt("/projects/abc");
    expect(screen.getByRole("heading", { name: "Project not found" })).toBeTruthy();
    expect(readRecent()).toEqual([]);
    expect(localStorage.getItem(RECENT_KEY)).toBeNull();
  });

  it("still works when localStorage is blocked", async () => {
    const blocked = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    mockApi(fullRoutes);
    renderAt("/projects/1");
    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeTruthy();
    await waitFor(() => expect(blocked).toHaveBeenCalled()); // recording a visit hit the blocked storage
  });
});

describe("ProjectPage new epic", () => {
  const withCreate = (answer: (body: Record<string, unknown>) => Response) => {
    const writes: Record<string, unknown>[] = [];
    mockApi({
      ...fullRoutes,
      "/api/v1/projects/1/epics": async (req: Request) => {
        if (req.method !== "POST") return epics;
        const body = (await req.json()) as Record<string, unknown>;
        writes.push(body);
        return answer(body);
      },
    });
    return writes;
  };

  it("creates an epic and opens it", async () => {
    const writes = withCreate(() => json(epic({ id: 9, project_id: 1, name: "Reports" }), 201));
    renderAt("/projects/1");
    await screen.findByRole("heading", { name: "Alpha" });

    expect(screen.queryByRole("form", { name: "New epic" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New epic" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Reports" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Monthly reports" } });
    fireEvent.click(screen.getByRole("button", { name: "Create epic" }));

    await waitFor(() => expect(location()).toBe("/epics/9"));
    expect(screen.getByText("epic page")).toBeTruthy();
    expect(writes).toEqual([{ name: "Reports", description: "Monthly reports" }]);
  });

  it("shows the server's message next to the form and stays on the page", async () => {
    withCreate(() => problem(422, "validation failed", "name is required"));
    renderAt("/projects/1");
    await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "New epic" }));
    fireEvent.click(screen.getByRole("button", { name: "Create epic" }));
    const form = screen.getByRole("form", { name: "New epic" });
    expect((await within(form).findByRole("alert")).textContent).toContain("name is required");
    expect(location()).toBe("/projects/1");
  });

  it("can be cancelled", async () => {
    const writes = withCreate(() => json(epic(), 201));
    renderAt("/projects/1");
    await screen.findByRole("heading", { name: "Alpha" });
    fireEvent.click(screen.getByRole("button", { name: "New epic" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "New epic" })).toBeNull();
    expect(screen.getByRole("button", { name: "New epic" })).toBeTruthy();
    expect(writes).toHaveLength(0);
  });
});

describe("ProjectPage board: empty lanes are not shown", () => {
  const ALL = [
    "draft", "review", "design", "implementation", "ready_for_testing", "testing", "pr_review", "finished", "cancelled",
  ] as const;
  type State = ReturnType<typeof story>["state"];

  it("renders no lane, placeholder or zero count for a state without stories", async () => {
    mockApi(fullRoutes);
    renderAt("/projects/1");
    await screen.findByRole("heading", { name: "Alpha" });
    for (const state of ["review", "design", "ready_for_testing", "testing", "pr_review"]) {
      expect(screen.queryByRole("region", { name: `${state} stories` })).toBeNull();
    }
    expect(screen.queryByText("None")).toBeNull();
    expect(screen.queryByLabelText("0 stories")).toBeNull();
    expect(document.querySelectorAll(".board .column")).toHaveLength(4);
  });

  it("renders every lane, in workflow order, when every state has a story", async () => {
    mockApi({
      ...fullRoutes,
      // Listed in reverse so the order cannot come from the server's response.
      "/api/v1/projects/1/stories": [...ALL].reverse().map((state, i) =>
        story({ id: i + 1, epic_id: 1, name: `Story in ${state}`, state: state as State })),
    });
    renderAt("/projects/1");
    await screen.findByText("Story in draft");
    expect(regionLabels()).toEqual(ALL.map((s) => `${s} stories`));
    for (const state of ALL) {
      expect(within(column(state)).getByText(`Story in ${state}`)).toBeTruthy();
      expect(within(column(state)).getByLabelText("1 story")).toBeTruthy();
    }
    expect(screen.queryByText("None")).toBeNull();
  });

  it("hides finished and cancelled lanes when empty and shows them when they have stories", async () => {
    mockApi({
      ...fullRoutes,
      "/api/v1/projects/1/stories": [story({ id: 1, epic_id: 1, name: "Only draft", state: "draft" })],
    });
    renderAt("/projects/1");
    await screen.findByText("Only draft");
    expect(regionLabels()).toEqual(["draft stories"]);
    expect(screen.queryByRole("region", { name: "finished stories" })).toBeNull();
    expect(screen.queryByRole("region", { name: "cancelled stories" })).toBeNull();
  });

  it("shows a finished lane and a cancelled lane on their own once they have stories", async () => {
    mockApi({
      ...fullRoutes,
      "/api/v1/projects/1/stories": [
        story({ id: 1, epic_id: 1, name: "Done", state: "finished" }),
        story({ id: 2, epic_id: 1, name: "Dropped", state: "cancelled" }),
      ],
    });
    renderAt("/projects/1");
    await screen.findByText("Done");
    expect(regionLabels()).toEqual(["finished stories", "cancelled stories"]);
  });

  it("hides lanes that a filter empties and brings them back when the filter is cleared", async () => {
    mockApi(fullRoutes);
    renderAt("/projects/1");
    await screen.findByRole("heading", { name: "Alpha" });
    expect(regionLabels()).toEqual([
      "draft stories", "implementation stories", "finished stories", "cancelled stories",
    ]);

    // Billing has only the draft and the cancelled story.
    fireEvent.change(screen.getByLabelText("Epic"), { target: { value: "2" } });
    expect(regionLabels()).toEqual(["draft stories", "cancelled stories"]);
    expect(screen.queryByRole("region", { name: "implementation stories" })).toBeNull();
    expect(screen.queryByRole("region", { name: "finished stories" })).toBeNull();
    expect(screen.queryByText("None")).toBeNull();

    fireEvent.change(screen.getByLabelText("Epic"), { target: { value: "" } });
    expect(regionLabels()).toEqual([
      "draft stories", "implementation stories", "finished stories", "cancelled stories",
    ]);
  });

  it("evaluates emptiness after the assignee and tag filters too", async () => {
    mockApi(fullRoutes);
    renderAt("/projects/1?assignee=ann");
    await screen.findByRole("heading", { name: "Alpha" });
    expect(regionLabels()).toEqual(["implementation stories", "finished stories"]);

    fireEvent.change(screen.getByLabelText("Assignee"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Tag"), { target: { value: "frontend" } });
    expect(regionLabels()).toEqual(["draft stories"]);
    expect(location()).toBe("/projects/1?tag=frontend");
  });

  it("applies a filter from the URL to the lanes on first render", async () => {
    mockApi(fullRoutes);
    renderAt("/projects/1?epic=1&tag=backend");
    await screen.findByRole("heading", { name: "Alpha" });
    expect(regionLabels()).toEqual(["implementation stories", "finished stories"]);
  });

  it("shows no board at all when the filters match nothing", async () => {
    mockApi(fullRoutes);
    renderAt("/projects/1?assignee=ann&tag=frontend");
    await screen.findByRole("heading", { name: "Alpha" });
    expect(screen.getByText("No stories match the filters.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Clear filters" }).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole("region")).toHaveLength(0);
    expect(document.querySelector(".board")).toBeNull();
  });

  it("shows no board when the project has no stories", async () => {
    mockApi({ ...fullRoutes, "/api/v1/projects/1/stories": [] });
    renderAt("/projects/1");
    expect(await screen.findByText("This project has no stories yet.")).toBeTruthy();
    expect(screen.queryAllByRole("region")).toHaveLength(0);
    expect(document.querySelector(".board")).toBeNull();
  });
});

describe("ProjectPage board: ready_for_testing", () => {
  it("shows a ready_for_testing column between implementation and testing", async () => {
    mockApi({
      ...fullRoutes,
      "/api/v1/projects/1/stories": [
        // Cast until the generated schema lists the new state; then it is a no-op.
        story({ id: 5, epic_id: 1, name: "Session audit", state: "ready_for_testing" as ReturnType<typeof story>["state"] }),
        // Neighbours, so the order is visible now that empty lanes are not shown.
        story({ id: 6, epic_id: 1, name: "Token refresh", state: "implementation" }),
        story({ id: 7, epic_id: 1, name: "Password reset", state: "testing" }),
      ],
    });
    renderAt("/projects/1");
    await screen.findByText("Session audit");
    expect(regionLabels()).toEqual(["implementation stories", "ready_for_testing stories", "testing stories"]);
    expect(within(column("ready_for_testing")).getByText("Session audit")).toBeTruthy();
    expect(within(column("ready_for_testing")).getByLabelText("1 story")).toBeTruthy();
  });
});

describe("ProjectPage GitHub repository form", () => {
  const URL1 = "https://github.com/acme/widgets";
  const MSG_TEXT = "expected https://github.com/{owner}/{repo}";

  /** Cached queries the save must refresh: they are kept active by this probe. */
  function CacheProbe() {
    const get = (key: unknown[], path: string) => useQuery({ queryKey: key, queryFn: () => fetch(new Request(new URL(path, window.location.origin))).then((r) => r.json()) });
    get(["project", 1, "issues"], "/api/v1/projects/1/issues");
    get(["story", 5], "/api/v1/stories/5");
    get(["projects"], "/api/v1/projects");
    return null;
  }

  /** A stateful fake of PATCH /projects/1 that stores what it is given. */
  function setupRepo(saved = "", patch?: (body: Record<string, unknown>) => Response | Promise<Response> | undefined) {
    const state = { saved, bodies: [] as Record<string, unknown>[] };
    const server = mockApi({
      ...fullRoutes,
      "/api/v1/projects/1": async (req: Request) => {
        if (req.method === "PATCH") {
          const body = (await req.clone().json()) as Record<string, unknown>;
          state.bodies.push(body);
          const custom = await patch?.(body);
          if (custom) {
            if (custom.status < 400) state.saved = String(((await custom.clone().json()) as { github_repo_url?: string }).github_repo_url ?? "");
            return custom;
          }
          state.saved = String(body.github_repo_url ?? "").trim();
        }
        return { ...project, github_repo_url: state.saved };
      },
      "/api/v1/projects/1/issues": [],
      "/api/v1/stories/5": story({ id: 5 }),
      "/api/v1/projects": [],
    });
    return { state, ...server };
  }

  function renderProject() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/projects/1"]}>
          <Routes>
            <Route path="/projects/:projectId" element={<><ProjectPage /><CacheProbe /></>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  const input = () => screen.getByRole("textbox", { name: "GitHub repository" }) as HTMLInputElement;
  const form = () => screen.getByRole("form", { name: "GitHub repository" });
  const save = () => within(form()).getByRole("button", { name: "Save" }) as HTMLButtonElement;
  const type = (v: string) => fireEvent.change(input(), { target: { value: v } });
  const loadedPage = () => screen.findByRole("heading", { name: "Alpha" });

  it("shows an empty form and no repo link when no repo is linked", async () => {
    setupRepo("");
    renderProject();
    await loadedPage();
    expect(input().value).toBe("");
    expect(input().getAttribute("placeholder")).toBe("https://github.com/owner/repo");
    expect(input().getAttribute("type")).not.toBe("url");
    expect(save().disabled).toBe(true);
    expect(screen.queryByRole("link", { name: "acme/widgets" })).toBeNull();
    expect(document.querySelector('a[href^="https://github.com/"]')).toBeNull();
  });

  it("shows the saved URL in the input and an owner/repo link that opens in a new tab", async () => {
    setupRepo(URL1);
    renderProject();
    await loadedPage();
    await waitFor(() => expect(input().value).toBe(URL1));
    const link = screen.getByRole("link", { name: "acme/widgets" });
    expect(link.getAttribute("href")).toBe(URL1);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(save().disabled).toBe(true);
  });

  it("enables Save only when the trimmed text differs from the saved value", async () => {
    setupRepo(URL1);
    renderProject();
    await loadedPage();
    await waitFor(() => expect(input().value).toBe(URL1));
    type(`  ${URL1}  `);
    expect(save().disabled).toBe(true);
    type("https://github.com/acme/other");
    expect(save().disabled).toBe(false);
    type(URL1);
    expect(save().disabled).toBe(true);
  });

  it("sends the text exactly as typed, without a client-side format check", async () => {
    const { state } = setupRepo("");
    renderProject();
    await loadedPage();
    type("  not a url at all  ");
    fireEvent.click(save());
    await waitFor(() => expect(state.bodies).toEqual([{ github_repo_url: "  not a url at all  " }]));
  });

  it("clears the link with an empty value, at once and without a confirmation", async () => {
    const { state } = setupRepo(URL1);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderProject();
    await loadedPage();
    await waitFor(() => expect(input().value).toBe(URL1));
    type("");
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await waitFor(() => expect(state.bodies).toEqual([{ github_repo_url: "" }]));
    await waitFor(() => expect(screen.queryByRole("link", { name: "acme/widgets" })).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(input().value).toBe("");
    confirm.mockRestore();
  });

  it("sends a whitespace-only value as the empty string", async () => {
    const { state } = setupRepo(URL1);
    renderProject();
    await loadedPage();
    await waitFor(() => expect(input().value).toBe(URL1));
    type("   ");
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await waitFor(() => expect(state.bodies).toEqual([{ github_repo_url: "" }]));
    await waitFor(() => expect(screen.queryByRole("link", { name: "acme/widgets" })).toBeNull());
  });

  it("shows the server's detail in an alert inside the form on 422, keeps the saved state and dismisses it on edit", async () => {
    setupRepo(URL1, () => problem(422, "invalid", MSG_TEXT));
    renderProject();
    await loadedPage();
    await waitFor(() => expect(input().value).toBe(URL1));
    type("nope");
    fireEvent.click(save());
    const alert = await within(form()).findByRole("alert");
    expect(alert.textContent).toContain(MSG_TEXT);
    expect(screen.getByRole("link", { name: "acme/widgets" }).getAttribute("href")).toBe(URL1);
    expect(input().value).toBe("nope");
    expect(save().disabled).toBe(false);
    expect(screen.queryByText("Saved")).toBeNull();
    type("nope2");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows Saved (not an alert, not an output), the canonical value from the server, and hides Saved on the next edit", async () => {
    setupRepo("", () => json({ ...project, github_repo_url: URL1 }));
    renderProject();
    await loadedPage();
    type("HTTPS://GitHub.com/Acme/Widgets.git");
    fireEvent.click(save());
    const saved = await screen.findByText("Saved");
    expect(saved.getAttribute("role")).not.toBe("alert");
    expect(saved.tagName).not.toBe("OUTPUT");
    expect(saved.closest("output")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(input().value).toBe(URL1));
    expect(screen.getByRole("link", { name: "acme/widgets" }).getAttribute("href")).toBe(URL1);
    type(URL1 + "x");
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("does not update optimistically: while the request is pending the link and saved state stay and Save is disabled", async () => {
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((res) => (release = res));
    setupRepo(URL1, () => pending);
    renderProject();
    await loadedPage();
    await waitFor(() => expect(input().value).toBe(URL1));
    type("https://github.com/acme/other");
    fireEvent.click(save());
    await waitFor(() => expect(save().disabled).toBe(true));
    expect(screen.getByRole("link", { name: "acme/widgets" }).getAttribute("href")).toBe(URL1);
    expect(screen.queryByRole("link", { name: "acme/other" })).toBeNull();
    expect(screen.queryByText("Saved")).toBeNull();
    release(json({ ...project, github_repo_url: "https://github.com/acme/other" }));
    await screen.findByText("Saved");
    expect(screen.getByRole("link", { name: "acme/other" })).toBeTruthy();
  });

  it("refetches the project, its issues, every cached story and the project list after a successful save", async () => {
    const { calls } = setupRepo("");
    renderProject();
    await loadedPage();
    await waitFor(() => expect(calls).toContain("/api/v1/stories/5"));
    const count = (path: string) => calls.filter((c) => c === path).length;
    const before = {
      project: count("/api/v1/projects/1"),
      issues: count("/api/v1/projects/1/issues"),
      story: count("/api/v1/stories/5"),
      projects: count("/api/v1/projects"),
    };
    type(URL1);
    fireEvent.click(save());
    await screen.findByText("Saved");
    await waitFor(() => {
      // the PATCH itself is one more call on /projects/1, so expect at least two there
      expect(count("/api/v1/projects/1")).toBeGreaterThanOrEqual(before.project + 2);
      expect(count("/api/v1/projects/1/issues")).toBe(before.issues + 1);
      expect(count("/api/v1/stories/5")).toBe(before.story + 1);
      expect(count("/api/v1/projects")).toBe(before.projects + 1);
    });
  });

  it("refetches nothing when the save is refused", async () => {
    const { calls } = setupRepo("", () => problem(422, "invalid", MSG_TEXT));
    renderProject();
    await loadedPage();
    await waitFor(() => expect(calls).toContain("/api/v1/stories/5"));
    const before = calls.length;
    type("nope");
    fireEvent.click(save());
    await within(form()).findByRole("alert");
    expect(calls.length).toBe(before + 1); // only the PATCH
  });
});

describe("ProjectPage board: lane cap", () => {
  type Over = NonNullable<Parameters<typeof story>[0]>;
  const day = (d: number) => `2026-02-${String(d).padStart(2, "0")}T10:00:00Z`;
  /** A story named after its id, updated on the given day of February. */
  const mk = (id: number, state: Over["state"], d: number, over: Over = {}) =>
    story({ id, epic_id: 1, name: `Story ${id}`, state, updated_at: day(d), ...over });
  const names = (...ids: number[]) => ids.map((id) => `Story ${id}`);
  /** Names of the cards in one lane, top to bottom. */
  const laneCards = (state: string) =>
    Array.from(column(state).querySelectorAll(".card strong")).map((el) => el.textContent);
  const toggle = (state: string) => within(column(state)).queryByRole("button", { name: /^Show (all|fewer)/ });

  // The API lists them in an order that is neither by id nor by update time.
  const capStories = [
    // draft: 7 stories; 12 and 14 share a timestamp (14 first). Most recent first:
    // 14, 12, 16, 15, 11, 17, 13.
    mk(15, "draft", 5), mk(13, "draft", 1), mk(11, "draft", 3), mk(17, "draft", 2),
    mk(12, "draft", 9), mk(16, "draft", 7), mk(14, "draft", 9),
    // review: exactly 5, all updated at the same time: 35 .. 31.
    mk(31, "review", 4), mk(33, "review", 4), mk(35, "review", 4), mk(32, "review", 4), mk(34, "review", 4),
    // implementation: 3, listed by id; most recent first: 22, 23, 21.
    mk(21, "implementation", 2), mk(22, "implementation", 8), mk(23, "implementation", 5),
    // finished: 8; most recent first: 43, 46, 41, 48, 44, 47, 42, 45.
    mk(41, "finished", 6), mk(42, "finished", 2), mk(43, "finished", 8), mk(44, "finished", 4),
    mk(45, "finished", 1), mk(46, "finished", 7), mk(47, "finished", 3), mk(48, "finished", 5),
    // cancelled: 6; most recent first: 52, 54, 51, 55, 56, 53.
    mk(51, "cancelled", 4), mk(52, "cancelled", 6), mk(53, "cancelled", 1),
    mk(54, "cancelled", 5), mk(55, "cancelled", 3), mk(56, "cancelled", 2),
  ];
  const capRoutes = { ...fullRoutes, "/api/v1/projects/1/stories": capStories };

  async function load(url = "/projects/1", routes: Record<string, unknown> = capRoutes) {
    mockApi(routes);
    const view = renderAt(url);
    await screen.findByRole("heading", { name: "Alpha" });
    return view;
  }

  it("uses a limit of 5", () => {
    expect(LANE_LIMIT).toBe(5);
  });

  it("shows only the 5 most recently updated stories of a lane with more than 5", async () => {
    await load();
    expect(laneCards("draft")).toEqual(names(14, 12, 16, 15, 11));
    expect(within(column("draft")).getAllByRole("link", { name: /^Story / })).toHaveLength(5);
    expect(screen.queryByText("Story 17")).toBeNull();
    expect(screen.queryByText("Story 13")).toBeNull();
  });

  it("orders every lane by updated_at, most recent first, higher id first on a tie", async () => {
    await load();
    expect(laneCards("draft")).toEqual(names(14, 12, 16, 15, 11)); // 14 before 12: same time
    expect(laneCards("review")).toEqual(names(35, 34, 33, 32, 31)); // all tied: by id, descending
    expect(laneCards("implementation")).toEqual(names(22, 23, 21)); // not the API's id order
    expect(laneCards("finished")).toEqual(names(43, 46, 41, 48, 44));
    expect(laneCards("cancelled")).toEqual(names(52, 54, 51, 55, 56));
    // Lanes keep the workflow order.
    expect(regionLabels()).toEqual([
      "draft stories", "review stories", "implementation stories", "finished stories", "cancelled stories",
    ]);
  });

  it("orders a lane the same whatever order the API returns", async () => {
    await load("/projects/1", { ...fullRoutes, "/api/v1/projects/1/stories": [...capStories].reverse() });
    expect(laneCards("draft")).toEqual(names(14, 12, 16, 15, 11));
    expect(laneCards("review")).toEqual(names(35, 34, 33, 32, 31));
    expect(laneCards("implementation")).toEqual(names(22, 23, 21));
  });

  it("orders a lane of one or two stories by update time too", async () => {
    await load("/projects/1", {
      ...fullRoutes,
      "/api/v1/projects/1/stories": [mk(2, "testing", 3), mk(3, "pr_review", 1), mk(1, "testing", 9)],
    });
    expect(laneCards("testing")).toEqual(names(1, 2));
    expect(laneCards("pr_review")).toEqual(names(3));
    expect(toggle("testing")).toBeNull();
  });

  it("keeps the lane total in the header count, not the number of cards shown", async () => {
    await load();
    expect(within(column("draft")).getByLabelText("7 stories").textContent).toBe("7");
    expect(within(column("finished")).getByLabelText("8 stories").textContent).toBe("8");
    expect(within(column("cancelled")).getByLabelText("6 stories").textContent).toBe("6");
    expect(within(column("review")).getByLabelText("5 stories").textContent).toBe("5");
    expect(within(column("implementation")).getByLabelText("3 stories").textContent).toBe("3");

    fireEvent.click(within(column("draft")).getByRole("button", { name: "Show all 7" }));
    expect(within(column("draft")).getByLabelText("7 stories").textContent).toBe("7");
  });

  it("expands a capped lane with Show all N and collapses it with Show fewer", async () => {
    await load();
    const lane = () => within(column("draft"));
    expect(lane().getByRole("button", { name: "Show all 7" })).toBeTruthy();
    expect(lane().queryByRole("button", { name: "Show fewer" })).toBeNull();

    fireEvent.click(lane().getByRole("button", { name: "Show all 7" }));
    expect(laneCards("draft")).toEqual(names(14, 12, 16, 15, 11, 17, 13));
    expect(lane().getByRole("button", { name: "Show fewer" })).toBeTruthy();
    expect(lane().queryByRole("button", { name: "Show all 7" })).toBeNull();

    fireEvent.click(lane().getByRole("button", { name: "Show fewer" }));
    expect(laneCards("draft")).toEqual(names(14, 12, 16, 15, 11));
    expect(lane().getByRole("button", { name: "Show all 7" })).toBeTruthy();
    expect(lane().queryByRole("button", { name: "Show fewer" })).toBeNull();
  });

  it("places the toggle under the lane's cards", async () => {
    await load();
    const button = within(column("draft")).getByRole("button", { name: "Show all 7" });
    const cards = column("draft").querySelector("ul.cards")!;
    expect(cards.contains(button)).toBe(false);
    expect(cards.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("toggles each lane on its own", async () => {
    await load();
    fireEvent.click(within(column("draft")).getByRole("button", { name: "Show all 7" }));
    expect(laneCards("draft")).toHaveLength(7);
    expect(laneCards("finished")).toEqual(names(43, 46, 41, 48, 44));
    expect(within(column("finished")).getByRole("button", { name: "Show all 8" })).toBeTruthy();
    expect(laneCards("cancelled")).toHaveLength(5);
    expect(within(column("cancelled")).getByRole("button", { name: "Show all 6" })).toBeTruthy();

    fireEvent.click(within(column("finished")).getByRole("button", { name: "Show all 8" }));
    expect(laneCards("finished")).toHaveLength(8);
    expect(laneCards("draft")).toHaveLength(7);

    fireEvent.click(within(column("draft")).getByRole("button", { name: "Show fewer" }));
    expect(laneCards("draft")).toHaveLength(5);
    expect(laneCards("finished")).toHaveLength(8);
    expect(within(column("finished")).getByRole("button", { name: "Show fewer" })).toBeTruthy();
    expect(laneCards("cancelled")).toHaveLength(5);
  });

  it("shows every card and no toggle in a lane of 5 or fewer", async () => {
    await load();
    expect(laneCards("review")).toHaveLength(5);
    expect(toggle("review")).toBeNull();
    expect(laneCards("implementation")).toHaveLength(3);
    expect(toggle("implementation")).toBeNull();
  });

  it("shows no toggle anywhere when no lane has more than 5", async () => {
    await load("/projects/1", fullRoutes);
    expect(screen.queryByRole("button", { name: /^Show (all|fewer)/ })).toBeNull();
    expect(cardNames()).toHaveLength(4);
  });

  it("caps a lane of exactly 6", async () => {
    await load("/projects/1", {
      ...fullRoutes,
      "/api/v1/projects/1/stories": [1, 2, 3, 4, 5, 6].map((id) => mk(id, "design", id)),
    });
    expect(laneCards("design")).toEqual(names(6, 5, 4, 3, 2));
    fireEvent.click(within(column("design")).getByRole("button", { name: "Show all 6" }));
    expect(laneCards("design")).toEqual(names(6, 5, 4, 3, 2, 1));
  });

  it("caps and toggles finished and cancelled lanes like any other", async () => {
    await load();
    expect(laneCards("finished")).toEqual(names(43, 46, 41, 48, 44));
    expect(laneCards("cancelled")).toEqual(names(52, 54, 51, 55, 56));

    fireEvent.click(within(column("finished")).getByRole("button", { name: "Show all 8" }));
    expect(laneCards("finished")).toEqual(names(43, 46, 41, 48, 44, 47, 42, 45));
    fireEvent.click(within(column("cancelled")).getByRole("button", { name: "Show all 6" }));
    expect(laneCards("cancelled")).toEqual(names(52, 54, 51, 55, 56, 53));

    fireEvent.click(within(column("finished")).getByRole("button", { name: "Show fewer" }));
    fireEvent.click(within(column("cancelled")).getByRole("button", { name: "Show fewer" }));
    expect(laneCards("finished")).toEqual(names(43, 46, 41, 48, 44));
    expect(laneCards("cancelled")).toEqual(names(52, 54, 51, 55, 56));
  });

  describe("with filters", () => {
    // 12 draft stories. Epic 1: 61..68 (ann: 61..67; tag ui: 62..67). Epic 2: 71..74 (bob, tag ui).
    const filterStories = [
      mk(61, "draft", 1, { assignee: "ann" }),
      mk(62, "draft", 12, { assignee: "ann", tags: ["ui"] }),
      mk(63, "draft", 3, { assignee: "ann", tags: ["ui"] }),
      mk(64, "draft", 10, { assignee: "ann", tags: ["ui"] }),
      mk(65, "draft", 5, { assignee: "ann", tags: ["ui"] }),
      mk(66, "draft", 8, { assignee: "ann", tags: ["ui"] }),
      mk(67, "draft", 7, { assignee: "ann", tags: ["ui"] }),
      mk(68, "draft", 6),
      mk(71, "draft", 11, { epic_id: 2, assignee: "bob", tags: ["ui"] }),
      mk(72, "draft", 2, { epic_id: 2, assignee: "bob", tags: ["ui"] }),
      mk(73, "draft", 9, { epic_id: 2, assignee: "bob", tags: ["ui"] }),
      mk(74, "draft", 4, { epic_id: 2, assignee: "bob", tags: ["ui"] }),
    ];
    const filterRoutes = { ...fullRoutes, "/api/v1/projects/1/stories": [...filterStories].reverse() };
    const draft = () => within(column("draft"));

    it("caps the unfiltered lane at its 5 most recent of all 12", async () => {
      await load("/projects/1", filterRoutes);
      expect(laneCards("draft")).toEqual(names(62, 71, 64, 73, 66));
      expect(draft().getByRole("button", { name: "Show all 12" })).toBeTruthy();
    });

    it("caps after the epic filter, with the filtered total", async () => {
      await load("/projects/1?epic=1", filterRoutes);
      expect(laneCards("draft")).toEqual(names(62, 64, 66, 67, 68));
      expect(draft().getByLabelText("8 stories")).toBeTruthy();
      fireEvent.click(draft().getByRole("button", { name: "Show all 8" }));
      expect(laneCards("draft")).toEqual(names(62, 64, 66, 67, 68, 65, 63, 61));
    });

    it("caps after the assignee filter, with the filtered total", async () => {
      await load("/projects/1?assignee=ann", filterRoutes);
      expect(laneCards("draft")).toEqual(names(62, 64, 66, 67, 65));
      expect(draft().getByLabelText("7 stories")).toBeTruthy();
      expect(draft().getByRole("button", { name: "Show all 7" })).toBeTruthy();
    });

    it("caps after the tag filter, with the filtered total", async () => {
      await load("/projects/1?tag=ui", filterRoutes);
      expect(laneCards("draft")).toEqual(names(62, 71, 64, 73, 66));
      expect(draft().getByLabelText("10 stories")).toBeTruthy();
      fireEvent.click(draft().getByRole("button", { name: "Show all 10" }));
      expect(laneCards("draft")).toEqual(names(62, 71, 64, 73, 66, 67, 65, 74, 63, 72));
    });

    it("drops the toggle when the filtered lane has 5 or fewer", async () => {
      await load("/projects/1?epic=2", filterRoutes);
      expect(laneCards("draft")).toEqual(names(71, 73, 74, 72));
      expect(toggle("draft")).toBeNull();
    });

    it("recaps when a filter is chosen on the page", async () => {
      await load("/projects/1", filterRoutes);
      fireEvent.change(screen.getByLabelText("Epic"), { target: { value: "1" } });
      expect(laneCards("draft")).toEqual(names(62, 64, 66, 67, 68));
      expect(draft().getByRole("button", { name: "Show all 8" })).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Epic"), { target: { value: "2" } });
      expect(laneCards("draft")).toHaveLength(4);
      expect(toggle("draft")).toBeNull();
    });
  });

  describe("toggle state is not stored", () => {
    const snapshot = () => {
      const out: Record<string, string | null> = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i)!;
        out[key] = window.localStorage.getItem(key);
      }
      return out;
    };

    it("changes neither the URL nor localStorage", async () => {
      await load();
      await waitFor(() => expect(readRecent().length).toBeGreaterThan(0)); // the visit is recorded
      const before = snapshot();
      const url = location();

      fireEvent.click(within(column("draft")).getByRole("button", { name: "Show all 7" }));
      expect(location()).toBe(url);
      expect(snapshot()).toEqual(before);

      fireEvent.click(within(column("draft")).getByRole("button", { name: "Show fewer" }));
      expect(location()).toBe(url);
      expect(snapshot()).toEqual(before);
    });

    it("starts every lane capped when the page is opened again", async () => {
      const first = await load();
      fireEvent.click(within(column("draft")).getByRole("button", { name: "Show all 7" }));
      fireEvent.click(within(column("finished")).getByRole("button", { name: "Show all 8" }));
      expect(laneCards("draft")).toHaveLength(7);
      first.unmount();

      await load();
      expect(laneCards("draft")).toEqual(names(14, 12, 16, 15, 11));
      expect(within(column("draft")).getByRole("button", { name: "Show all 7" })).toBeTruthy();
      expect(laneCards("finished")).toHaveLength(5);
      expect(within(column("finished")).getByRole("button", { name: "Show all 8" })).toBeTruthy();
    });

    it("starts every lane capped when another project is opened", async () => {
      function GoTo({ to }: { to: string }) {
        const navigate = useNavigate();
        return <button type="button" onClick={() => navigate(to)}>Go to {to}</button>;
      }
      mockApi({
        ...capRoutes,
        "/api/v1/projects/2": { ...project, id: 2, name: "Beta" },
        "/api/v1/projects/2/epics": [epic({ id: 3, project_id: 2, name: "Beta epic" })],
        "/api/v1/projects/2/stories": [1, 2, 3, 4, 5, 6, 7].map((i) =>
          mk(80 + i, "draft", i, { project_id: 2, epic_id: 3 })),
      });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/projects/1"]}>
            <Routes>
              <Route path="/projects/:projectId" element={<ProjectPage />} />
            </Routes>
            <GoTo to="/projects/2" />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      await screen.findByRole("heading", { name: "Alpha" });
      fireEvent.click(within(column("draft")).getByRole("button", { name: "Show all 7" }));
      expect(laneCards("draft")).toHaveLength(7);

      fireEvent.click(screen.getByRole("button", { name: "Go to /projects/2" }));
      await screen.findByRole("heading", { name: "Beta" });
      await screen.findByText("Story 87");
      expect(laneCards("draft")).toEqual(names(87, 86, 85, 84, 83));
      expect(within(column("draft")).getByRole("button", { name: "Show all 7" })).toBeTruthy();
      expect(within(column("draft")).queryByRole("button", { name: "Show fewer" })).toBeNull();
    });
  });
});
