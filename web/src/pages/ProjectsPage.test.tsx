import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import ProjectsPage from "./ProjectsPage";
import { mockApi, problem, project } from "../test/fixtures";

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProjectsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ProjectsPage (all projects)", () => {
  it("lists every project, each linking to its overview", async () => {
    const { calls } = mockApi({
      "/api/v1/projects": [project({ id: 1, name: "Alpha", description: "first" }), project({ id: 2, name: "Beta" })],
    });
    renderPage();
    expect(await screen.findByText("first")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Alpha" }).getAttribute("href")).toBe("/projects/1");
    expect(screen.getByRole("link", { name: "Beta" }).getAttribute("href")).toBe("/projects/2");
    expect(calls).toEqual(["/api/v1/projects"]);
  });

  it("links back to the home page", async () => {
    mockApi({ "/api/v1/projects": [] });
    renderPage();
    expect((await screen.findByRole("link", { name: /Home/ })).getAttribute("href")).toBe("/");
  });

  it("says so when there are no projects", async () => {
    mockApi({ "/api/v1/projects": [] });
    renderPage();
    expect(await screen.findByText(/No projects yet/)).toBeTruthy();
  });

  it("shows the server's message when loading fails", async () => {
    mockApi({ "/api/v1/projects": problem(500, "internal error", "database is on fire") });
    renderPage();
    expect((await screen.findByRole("alert")).textContent).toContain("database is on fire");
  });
});
