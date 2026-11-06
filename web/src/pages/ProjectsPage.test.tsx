import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import ProjectsPage from "./ProjectsPage";

function json(body: unknown, status = 200, type = "application/json") {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": type },
  });
}

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

afterEach(() => vi.unstubAllGlobals());

describe("ProjectsPage", () => {
  it("lists projects from the API", async () => {
    const fetchMock = vi.fn(async (_req: Request) =>
      json([
        {
          id: 1,
          name: "Alpha",
          description: "first",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderPage();
    expect(await screen.findByText("Alpha")).toBeTruthy();
    const req = fetchMock.mock.calls[0][0];
    expect(new URL(req.url).pathname).toBe("/api/v1/projects");
  });

  it("shows the server's problem detail when creating fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (req: Request) =>
        req.method === "POST"
          ? json(
              { title: "validation failed", status: 422, detail: "name is required" },
              422,
              "application/problem+json",
            )
          : json([]),
      ),
    );
    renderPage();
    await screen.findByText("No projects yet.");
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("name is required"),
    );
  });
});
