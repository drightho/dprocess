import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import LandingPage from "./LandingPage";
import { RECENT_KEY } from "../lib/recent";
import { json, mockApi, problem, project } from "../test/fixtures";

const base = [
  project({ id: 1, name: "Alpha", description: "first project" }),
  project({ id: 2, name: "Beta" }),
  project({ id: 3, name: "Gamma" }),
  project({ id: 4, name: "Delta" }),
];

function LocationProbe() {
  const l = useLocation();
  return <span data-testid="location">{l.pathname + l.search}</span>;
}

function renderLanding() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/projects" element={<p>all projects page</p>} />
          <Route path="/projects/:projectId" element={<p>project page</p>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 12, minute)).toISOString();
const seed = (list: unknown) => localStorage.setItem(RECENT_KEY, typeof list === "string" ? list : JSON.stringify(list));
const stored = () => JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as { id: number }[];
const location = () => screen.getByTestId("location").textContent;
const recentList = () => screen.queryByRole("list", { name: "Recently visited projects" });
const recentNames = () =>
  within(screen.getByRole("list", { name: "Recently visited projects" }))
    .getAllByRole("link")
    .map((a) => a.textContent);
const search = (text: string) => {
  fireEvent.change(screen.getByLabelText("Project name"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
};

describe("recently visited projects", () => {
  it("lists them newest first, with the server's current names", async () => {
    mockApi({ "/api/v1/projects": base });
    seed([
      { id: 2, name: "Beta (old name)", visitedAt: at(30) },
      { id: 1, name: "Alpha", visitedAt: at(50) },
      { id: 3, name: "Gamma", visitedAt: at(10) },
    ]);
    renderLanding();

    await screen.findByRole("list", { name: "Recently visited projects" });
    expect(recentNames()).toEqual(["Alpha", "Beta", "Gamma"]); // by visit time; renamed project shows its new name
    const links = within(recentList()!).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/projects/1", "/projects/2", "/projects/3"]);
    expect(screen.getByText("first project")).toBeTruthy();
  });

  it("does not list projects that were never visited", async () => {
    mockApi({ "/api/v1/projects": base });
    seed([{ id: 1, name: "Alpha", visitedAt: at(1) }]);
    renderLanding();
    await screen.findByRole("list", { name: "Recently visited projects" });
    expect(recentNames()).toEqual(["Alpha"]); // Beta, Gamma and Delta exist but were not visited
  });

  it("shows at most ten, the most recent ones", async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => project({ id: i + 1, name: `P${i + 1}` }));
    mockApi({ "/api/v1/projects": twelve });
    seed(twelve.map((p) => ({ id: p.id, name: p.name, visitedAt: at(p.id) })));
    renderLanding();
    await screen.findByRole("list", { name: "Recently visited projects" });
    expect(recentNames()).toEqual(["P12", "P11", "P10", "P9", "P8", "P7", "P6", "P5", "P4", "P3"]);
  });

  it("drops projects deleted on the server, and forgets them", async () => {
    mockApi({ "/api/v1/projects": base });
    seed([
      { id: 99, name: "Deleted", visitedAt: at(9) },
      { id: 2, name: "Beta", visitedAt: at(8) },
    ]);
    renderLanding();
    await screen.findByRole("list", { name: "Recently visited projects" });
    expect(recentNames()).toEqual(["Beta"]);
    expect(screen.queryByText("Deleted")).toBeNull();
    await waitFor(() => expect(stored().map((r) => r.id)).toEqual([2]));
  });

  it("explains the empty state when nothing was visited", async () => {
    mockApi({ "/api/v1/projects": base });
    renderLanding();
    expect(await screen.findByText(/No recently visited projects yet/)).toBeTruthy();
    expect(recentList()).toBeNull();
  });

  it("shows the empty state when every visited project has been deleted", async () => {
    mockApi({ "/api/v1/projects": [] });
    seed([{ id: 5, name: "Gone", visitedAt: at(1) }]);
    renderLanding();
    expect(await screen.findByText(/No recently visited projects yet/)).toBeTruthy();
  });

  it("reports when the projects cannot be loaded", async () => {
    mockApi({ "/api/v1/projects": problem(500, "internal error", "database is on fire") });
    renderLanding();
    expect((await screen.findByRole("alert")).textContent).toContain("database is on fire");
  });

  it("links to the full list of projects", async () => {
    mockApi({ "/api/v1/projects": base });
    renderLanding();
    const link = await screen.findByRole("link", { name: "Browse all projects" });
    expect(link.getAttribute("href")).toBe("/projects");
  });
});

describe("unusable browser storage", () => {
  it("copes with corrupt stored data", async () => {
    mockApi({ "/api/v1/projects": base });
    seed("{definitely not json");
    renderLanding();
    expect(await screen.findByText(/No recently visited projects yet/)).toBeTruthy();
    search("Beta");
    await waitFor(() => expect(location()).toBe("/projects/2"));
  });

  it("copes with entries of the wrong shape", async () => {
    mockApi({ "/api/v1/projects": base });
    seed([{ id: "x" }, null, 5, { id: 2, name: "Beta", visitedAt: at(1) }]);
    renderLanding();
    await screen.findByRole("list", { name: "Recently visited projects" });
    expect(recentNames()).toEqual(["Beta"]);
  });

  it("works when localStorage is blocked", async () => {
    const blocked = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    mockApi({ "/api/v1/projects": base });
    renderLanding();
    expect(await screen.findByText(/No recently visited projects yet/)).toBeTruthy();
    search("Gamma");
    await waitFor(() => expect(location()).toBe("/projects/3"));
    expect(blocked).toHaveBeenCalled(); // the page really did hit the blocked storage
  });
});

describe("project search", () => {
  it("opens the project with exactly that name", async () => {
    mockApi({ "/api/v1/projects": base });
    renderLanding();
    await screen.findByText(/No recently visited projects yet/);
    search("Beta");
    await waitFor(() => expect(location()).toBe("/projects/2"));
    expect(screen.getByText("project page")).toBeTruthy();
  });

  it("ignores letter case and surrounding spaces", async () => {
    mockApi({ "/api/v1/projects": base });
    renderLanding();
    await screen.findByText(/No recently visited projects yet/);
    search("  bETA ");
    await waitFor(() => expect(location()).toBe("/projects/2"));
  });

  it("can be submitted with Enter", async () => {
    mockApi({ "/api/v1/projects": base });
    renderLanding();
    await screen.findByText(/No recently visited projects yet/);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Delta" } });
    fireEvent.submit(screen.getByRole("search"));
    await waitFor(() => expect(location()).toBe("/projects/4"));
  });

  it("says so for an unknown name and changes nothing else", async () => {
    mockApi({ "/api/v1/projects": base });
    seed([{ id: 1, name: "Alpha", visitedAt: at(1) }]);
    renderLanding();
    await screen.findByRole("list", { name: "Recently visited projects" });

    search("Betaa");
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("No project named");
    expect(status.textContent).toContain("Betaa");
    expect(location()).toBe("/");
    expect(recentNames()).toEqual(["Alpha"]);
    expect((screen.getByLabelText("Project name") as HTMLInputElement).value).toBe("Betaa");
    expect(stored()).toHaveLength(1);
  });

  it("does not match part of a name", async () => {
    mockApi({ "/api/v1/projects": base });
    renderLanding();
    await screen.findByText(/No recently visited projects yet/);
    search("Alph");
    expect((await screen.findByRole("status")).textContent).toContain("No project named");
    expect(location()).toBe("/");
  });

  it("clears the message when the text changes", async () => {
    mockApi({ "/api/v1/projects": base });
    renderLanding();
    await screen.findByText(/No recently visited projects yet/);
    search("nope");
    await screen.findByRole("status");
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "no" } });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does nothing for an empty search", async () => {
    const { calls } = mockApi({ "/api/v1/projects": base });
    renderLanding();
    await screen.findByText(/No recently visited projects yet/);
    const before = calls.length;
    search("   ");
    expect(screen.queryByRole("status")).toBeNull();
    expect(calls.length).toBe(before);
    expect(location()).toBe("/");
  });

  it("lets you choose when several projects share the name", async () => {
    mockApi({ "/api/v1/projects": [...base, project({ id: 5, name: "Twin" }), project({ id: 6, name: "twin" }), project({ id: 7, name: "Twin" })] });
    renderLanding();
    await screen.findByText(/No recently visited projects yet/);

    search("TWIN"); // three projects match ignoring case, none in this exact case
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Several projects are named");
    const hrefs = within(status).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/projects/5", "/projects/6", "/projects/7"]);
    expect(location()).toBe("/");
  });

  it("prefers the project whose name has the same letter case", async () => {
    mockApi({ "/api/v1/projects": [project({ id: 1, name: "Alpha" }), project({ id: 8, name: "alpha" })] });
    renderLanding();
    await screen.findByText(/No recently visited projects yet/);
    search("alpha");
    await waitFor(() => expect(location()).toBe("/projects/8"));
  });

  it("asks the server again, so a project created elsewhere is found", async () => {
    let calls = 0;
    mockApi({ "/api/v1/projects": () => (++calls === 1 ? base : [...base, project({ id: 9, name: "Newbie" })]) });
    renderLanding();
    await screen.findByText(/No recently visited projects yet/);
    search("Newbie");
    await waitFor(() => expect(location()).toBe("/projects/9"));
  });

  it("reports a failed search", async () => {
    let calls = 0;
    mockApi({ "/api/v1/projects": () => (++calls === 1 ? base : problem(503, "unavailable", "server is restarting")) });
    renderLanding();
    await screen.findByText(/No recently visited projects yet/);
    search("Beta");
    await waitFor(() => expect(screen.getAllByRole("alert").some((a) => a.textContent?.includes("server is restarting"))).toBe(true));
    expect(location()).toBe("/");
  });
});

describe("creating a project from the landing page", () => {
  it("opens the new project", async () => {
    const { fetchMock } = mockApi({
      "/api/v1/projects": (req: Request) => (req.method === "POST" ? json(project({ id: 7, name: "Fresh" }), 201) : base),
    });
    renderLanding();
    await screen.findByText(/No recently visited projects yet/);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Fresh" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "brand new" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(location()).toBe("/projects/7"));
    const post = fetchMock.mock.calls.map((c) => c[0]).find((r) => r.method === "POST")!;
    expect(await post.json()).toEqual({ name: "Fresh", description: "brand new" });
  });

  it("shows the server's message when creating fails", async () => {
    mockApi({
      "/api/v1/projects": (req: Request) =>
        req.method === "POST" ? problem(422, "validation failed", "name is required") : base,
    });
    renderLanding();
    await screen.findByText(/No recently visited projects yet/);
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("name is required"));
    expect(location()).toBe("/");
  });
});
