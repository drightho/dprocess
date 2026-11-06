import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import App from "./App";
import { epic, mockApi, project, story } from "./test/fixtures";

function renderAt(url: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("App routes", () => {
  it("serves the project overview at /projects/:id (e.g. after a reload)", async () => {
    mockApi({
      "/api/v1/health": { status: "ok" },
      "/api/v1/projects/1": { id: 1, name: "Alpha", description: "", created_at: "", updated_at: "" },
      "/api/v1/projects/1/epics": [epic({ id: 1, name: "Auth" })],
      "/api/v1/projects/1/stories": [story({ id: 1, name: "Login" })],
    });
    renderAt("/projects/1?tag=none-such");
    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByText("Login")).toBeTruthy();
    expect(await screen.findByText("API ok")).toBeTruthy();
  });

  it("serves the landing page at /", async () => {
    mockApi({ "/api/v1/health": { status: "ok" }, "/api/v1/projects": [project({ id: 1, name: "Alpha" })] });
    renderAt("/");
    expect(await screen.findByRole("search", { name: "Find a project" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Recently visited" })).toBeTruthy();
    expect(screen.getByRole("form", { name: "New project" })).toBeTruthy();
  });

  it("serves the list of all projects at /projects", async () => {
    mockApi({ "/api/v1/health": { status: "ok" }, "/api/v1/projects": [project({ id: 1, name: "Alpha" })] });
    renderAt("/projects");
    expect(await screen.findByRole("heading", { name: "All projects" })).toBeTruthy();
    expect((await screen.findByRole("link", { name: "Alpha" })).getAttribute("href")).toBe("/projects/1");
  });

  it("shows a not-found page for unknown routes", () => {
    mockApi({ "/api/v1/health": { status: "ok" } });
    renderAt("/nowhere");
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeTruthy();
  });
});
