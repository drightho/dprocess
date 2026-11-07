import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import ProjectPage from "./ProjectPage";
import { RECENT_KEY, readRecent } from "../lib/recent";
import { epic, json, mockApi, problem, story } from "../test/fixtures";

const project = {
  id: 1,
  name: "Alpha",
  description: "The first project",
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

    // One column per state, in workflow order, each with its count.
    const regions = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
    expect(regions).toEqual([
      "draft stories", "review stories", "design stories", "implementation stories",
      "testing stories", "pr_review stories", "finished stories", "cancelled stories",
    ]);
    expect(within(column("implementation")).getByText("Logout")).toBeTruthy();
    expect(within(column("finished")).getByText("Login")).toBeTruthy();
    expect(within(column("cancelled")).getByText("Old idea")).toBeTruthy();
    expect(within(column("review")).getByText("None")).toBeTruthy();
    expect(within(column("implementation")).getByLabelText("1 story")).toBeTruthy();
    expect(within(column("review")).getByLabelText("0 stories")).toBeTruthy();

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
