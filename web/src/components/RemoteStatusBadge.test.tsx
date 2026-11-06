import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import RemoteStatusBadge from "./RemoteStatusBadge";
import { mockApi, problem } from "../test/fixtures";
import { remoteDisplay } from "../lib/github";

const sync = (enabled: boolean) => ({ enabled, last_run_at: null, last_error: "" });
type Remote = Parameters<typeof RemoteStatusBadge>[0]["status"];
const remote = (state: string, extra = {}): Remote => ({ state, title: "Add thing", checked_at: "2026-01-02T03:04:05.000Z", ...extra } as Remote);

function show(status: Parameters<typeof RemoteStatusBadge>[0]["status"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RemoteStatusBadge status={status} />
    </QueryClientProvider>,
  );
}

describe("RemoteStatusBadge", () => {
  it.each(["open", "closed", "merged"])("shows %s when the sync is on", async (state) => {
    mockApi({ "/api/v1/github-sync": sync(true) });
    show(remote(state));
    const badge = await screen.findByLabelText(`GitHub status: ${state}`);
    expect(badge.textContent).toBe(state);
    expect(badge.getAttribute("title")).toBe("Add thing - checked 2026-01-02 03:04 UTC");
  });

  it("shows unknown for stale or unavailable status", async () => {
    mockApi({ "/api/v1/github-sync": sync(true) });
    show(remote("unknown", { title: "" }));
    const badge = await screen.findByLabelText("GitHub status: unknown");
    expect(badge.getAttribute("title")).toBe("Status unavailable (last checked 2026-01-02 03:04 UTC)");
  });

  it("shows unknown when the server sent no status or one we do not know", async () => {
    mockApi({ "/api/v1/github-sync": sync(true) });
    show(undefined);
    expect((await screen.findByLabelText("GitHub status: unknown")).getAttribute("title")).toBe("Status unavailable");
  });

  it("renders nothing while the sync is off", async () => {
    const { calls } = mockApi({ "/api/v1/github-sync": sync(false) });
    const { container } = show(remote("open"));
    await vi.waitFor(() => expect(calls).toContain("/api/v1/github-sync"));
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when the sync status cannot be read", async () => {
    const { calls } = mockApi({ "/api/v1/github-sync": problem(500, "internal error", "boom") });
    const { container } = show(remote("open"));
    await vi.waitFor(() => expect(calls).toContain("/api/v1/github-sync"));
    expect(container.innerHTML).toBe("");
  });
});

describe("remoteDisplay", () => {
  const fmt = (s: string) => `<${s}>`;
  it("never guesses a state it does not know", () => {
    expect(remoteDisplay({ state: "draft", title: "", checked_at: null }, fmt)).toEqual({ state: "unknown", hint: "Status unavailable" });
  });
  it("omits a missing check time", () => {
    expect(remoteDisplay({ state: "open", title: "T", checked_at: null }, fmt).hint).toBe("T");
  });
});
