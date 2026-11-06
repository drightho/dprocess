import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import EpicPage from "./EpicPage";
import { epic, historyEntry, mockApi, problem, project, story, type HistoryEntry, type Story } from "../test/fixtures";

type EpicState = "draft" | "review" | "ready" | "finished" | "cancelled";

// What the server's epic workflow allows from each state.
const allowed: Record<EpicState, EpicState[]> = {
  draft: ["review", "cancelled"],
  review: ["ready", "cancelled"],
  ready: ["finished", "cancelled"],
  finished: [],
  cancelled: [],
};

interface Setup {
  state?: EpicState;
  stories?: Story[];
  history?: HistoryEntry[];
  /** Return a Response to make the transition endpoint answer with it instead of applying the move. */
  transition?: (body: { to: string; reason?: string }) => Response | undefined | Promise<Response | undefined>;
}

/** A small stateful fake of the epic endpoints: a successful transition changes what the next GET returns. */
function setup(init: Setup = {}) {
  const w = {
    epic: epic({ id: 1, project_id: 1, name: "Auth", description: "Sign-in and sessions", state: init.state ?? "draft", tags: ["q1"] }),
    stories: init.stories ?? [],
    history: init.history ?? [],
    posts: [] as { to: string; reason?: string }[],
  };
  const view = () => ({ ...w.epic, allowed_transitions: allowed[w.epic.state as EpicState] });
  const server = mockApi({
    "/api/v1/epics/1": () => view(),
    "/api/v1/epics/1/stories": () => w.stories,
    "/api/v1/epics/1/history": () => w.history,
    "/api/v1/projects/1": project({ id: 1, name: "Alpha" }),
    "/api/v1/epics/1/transition": async (req: Request) => {
      const body = (await req.json()) as { to: string; reason?: string };
      w.posts.push(body);
      const custom = await init.transition?.(body);
      if (custom) return custom;
      const from = w.epic.state;
      w.epic = { ...w.epic, state: body.to as EpicState };
      w.history = [...w.history, historyEntry({ id: w.history.length + 1, from_state: from, to_state: body.to, reason: body.reason ?? "" })];
      if (body.to === "cancelled") {
        w.stories = w.stories.map((s) => (s.state === "finished" || s.state === "cancelled" ? s : { ...s, state: "cancelled" }));
      }
      return view();
    },
  });
  return { w, ...server };
}

function renderAt(url = "/epics/1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/epics/:epicId" element={<EpicPage />} />
          <Route path="/" element={<p>home</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const button = (name: string | RegExp) => screen.queryByRole("button", { name });
const actionNames = () => within(screen.getByRole("region", { name: "Change state" })).queryAllByRole("button").map((b) => b.textContent);

const login = story({ id: 1, epic_id: 1, name: "Login", state: "finished", assignee: "ann", estimate_loc: 120 });
const logout = story({ id: 2, epic_id: 1, name: "Logout", state: "implementation" });
const invoice = story({ id: 3, epic_id: 1, name: "Invoice list", state: "draft", estimate_loc: 450, warnings: ["estimate_exceeds_400_loc"] });

describe("EpicPage content", () => {
  it("shows the epic with its project, stories and history", async () => {
    setup({
      state: "ready",
      stories: [login, logout, invoice],
      history: [
        historyEntry({ id: 1, from_state: "draft", to_state: "review", reason: "ready for review", actor: "ann", at: "2026-01-02T03:04:05.000Z" }),
        historyEntry({ id: 2, from_state: "review", to_state: "ready", at: "2026-01-03T10:00:00.000Z" }),
      ],
    });
    renderAt();

    expect(await screen.findByRole("heading", { name: "Auth" })).toBeTruthy();
    expect(screen.getByText("Sign-in and sessions")).toBeTruthy();
    expect(screen.getByText("q1")).toBeTruthy();
    const back = await screen.findByRole("link", { name: /Alpha/ });
    expect(back.getAttribute("href")).toBe("/projects/1");

    // Stories with their states, sizes and the over-400 warning.
    const cards = Array.from(document.querySelectorAll(".cards .card")).map((c) => c.textContent ?? "");
    expect(cards).toHaveLength(3);
    expect(cards[0]).toContain("Login");
    expect(cards[0]).toContain("finished");
    expect(cards[0]).toContain("120 LOC");
    expect(cards[1]).toContain("implementation");
    expect(cards[2]).toContain("Estimate is over 400 lines");
    expect(screen.getByText("1 of 3 stories finished")).toBeTruthy();

    // History: newest first, then the creation of the epic.
    const items = within(screen.getByRole("list", { name: "State history" })).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("2026-01-03 10:00 UTC");
    expect(items[0].textContent).toContain("review");
    expect(items[0].textContent).toContain("ready");
    expect(items[1].textContent).toContain("2026-01-02 03:04 UTC");
    expect(items[1].textContent).toContain("by ann");
    expect(items[1].textContent).toContain("ready for review");
    expect(items[2].textContent).toContain("Created");
    expect(items[2].textContent).toContain("2026-01-01 00:00 UTC");
  });

  it("handles an epic with no stories and no history", async () => {
    setup();
    renderAt();
    expect(await screen.findByText("This epic has no stories yet.")).toBeTruthy();
    const items = within(screen.getByRole("list", { name: "State history" })).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain("Created");
  });

  it("counts cancelled stories separately", async () => {
    setup({ stories: [login, story({ id: 4, epic_id: 1, name: "Dropped", state: "cancelled" })] });
    renderAt();
    expect(await screen.findByText("1 of 2 stories finished, 1 cancelled")).toBeTruthy();
  });

  it("still shows the page when only the history fails to load", async () => {
    mockApi({
      "/api/v1/epics/1": { ...epic({ id: 1, project_id: 1, name: "Auth" }), allowed_transitions: ["review", "cancelled"] },
      "/api/v1/epics/1/stories": [],
      "/api/v1/epics/1/history": problem(500, "internal error", "history is broken"),
      "/api/v1/projects/1": project({ id: 1, name: "Alpha" }),
    });
    renderAt();
    expect(await screen.findByRole("heading", { name: "Auth" })).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toContain("history is broken");
    expect(button("Move to review")).toBeTruthy();
  });
});

describe("EpicPage state changes", () => {
  it("offers only the moves the server allows", async () => {
    setup({ state: "draft" });
    const { unmount } = renderAt();
    await screen.findByRole("heading", { name: "Auth" });
    expect(actionNames()).toEqual(["Move to review", "Cancel epic"]);
    unmount();

    setup({ state: "ready" });
    renderAt();
    await screen.findByRole("heading", { name: "Auth" });
    expect(actionNames()).toEqual(["Move to finished", "Cancel epic"]);
  });

  it("moves the epic, sends the reason and refreshes the page", async () => {
    const { w, calls } = setup({ state: "draft", stories: [logout] });
    renderAt();
    await screen.findByRole("heading", { name: "Auth" });
    const epicGets = () => calls.filter((c) => c === "/api/v1/epics/1").length;
    const before = epicGets();

    fireEvent.change(screen.getByLabelText("Reason (optional)"), { target: { value: "ready for review" } });
    fireEvent.click(button("Move to review")!);

    expect((await screen.findByRole("status")).textContent).toBe("Epic moved to review.");
    expect(w.posts).toEqual([{ to: "review", reason: "ready for review" }]);
    // The panel now offers the next moves, the reason is cleared, and data was refetched.
    await waitFor(() => expect(actionNames()).toEqual(["Move to ready", "Cancel epic"]));
    expect((screen.getByLabelText("Reason (optional)") as HTMLInputElement).value).toBe("");
    expect(epicGets()).toBeGreaterThan(before);
    await waitFor(() => expect(within(screen.getByRole("list", { name: "State history" })).getAllByRole("listitem")).toHaveLength(2));
  });

  it("sends no reason when none was typed", async () => {
    const { w } = setup({ state: "review" });
    renderAt();
    await screen.findByRole("heading", { name: "Auth" });
    fireEvent.click(button("Move to ready")!);
    await screen.findByRole("status");
    expect(w.posts).toEqual([{ to: "ready" }]);
  });

  it("shows the server's explanation when finishing is blocked", async () => {
    const detail = 'transition blocked: epic cannot finish while stories are not finished or cancelled: #2 "Logout" (testing)';
    const { w } = setup({ state: "ready", stories: [login, logout], transition: () => problem(409, "conflict", detail) });
    renderAt();
    await screen.findByRole("heading", { name: "Auth" });

    fireEvent.click(button("Move to finished")!);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain('#2 "Logout" (testing)');
    expect(w.epic.state).toBe("ready");
    expect(screen.queryByRole("status")).toBeNull();
    // Nothing changed: the moves are still offered, so the user can try again later.
    expect(actionNames()).toEqual(["Move to finished", "Cancel epic"]);
  });

  it("clears an old error when the next attempt succeeds", async () => {
    let first = true;
    setup({ state: "review", transition: () => (first ? ((first = false), problem(409, "conflict", "nope")) : undefined) });
    renderAt();
    await screen.findByRole("heading", { name: "Auth" });
    fireEvent.click(button("Move to ready")!);
    await screen.findByRole("alert");
    fireEvent.click(button("Move to ready")!);
    await screen.findByRole("status");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores clicks while a request is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { w } = setup({ state: "draft", transition: async () => { await gate; return undefined; } });
    renderAt();
    await screen.findByRole("heading", { name: "Auth" });

    fireEvent.click(button("Move to review")!);
    await waitFor(() => expect((button("Move to review") as HTMLButtonElement).disabled).toBe(true));
    expect((button("Cancel epic") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button("Move to review")!);
    release();
    await screen.findByRole("status");
    expect(w.posts).toHaveLength(1);
  });

  it("offers no moves for finished or cancelled epics", async () => {
    for (const state of ["finished", "cancelled"] as const) {
      setup({ state });
      const { unmount } = renderAt();
      await screen.findByRole("heading", { name: "Auth" });
      expect(screen.getByText(`This epic is ${state}; its state can no longer change.`)).toBeTruthy();
      expect(screen.queryAllByRole("button")).toHaveLength(0);
      unmount();
    }
  });
});

describe("EpicPage cancelling", () => {
  it("asks first, listing the stories that will be cancelled, and can be called off", async () => {
    const { w } = setup({ state: "review", stories: [login, logout, invoice] });
    renderAt();
    await screen.findByRole("heading", { name: "Auth" });

    fireEvent.click(button("Cancel epic")!);
    const dialog = await screen.findByRole("alertdialog", { name: "Confirm cancelling the epic" });
    expect(dialog.textContent).toContain("Its 2 unfinished stories will be cancelled too");
    const listed = within(dialog).getAllByRole("listitem").map((li) => li.textContent);
    expect(listed.some((t) => t?.includes("Logout"))).toBe(true);
    expect(listed.some((t) => t?.includes("Invoice list"))).toBe(true);
    expect(listed.some((t) => t?.includes("Login"))).toBe(false); // finished: stays finished
    expect(dialog.textContent).toContain("Finished stories stay finished");
    expect(w.posts).toHaveLength(0); // nothing sent yet

    fireEvent.click(button("Keep epic")!);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(actionNames()).toEqual(["Move to ready", "Cancel epic"]);
    expect(w.posts).toHaveLength(0);
  });

  it("cancels the epic and its unfinished stories once confirmed", async () => {
    const { w } = setup({ state: "review", stories: [login, logout, invoice] });
    renderAt();
    await screen.findByRole("heading", { name: "Auth" });

    fireEvent.change(screen.getByLabelText("Reason (optional)"), { target: { value: "scope dropped" } });
    fireEvent.click(button("Cancel epic")!);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm cancel" }));

    expect((await screen.findByRole("status")).textContent).toBe("Epic moved to cancelled.");
    expect(w.posts).toEqual([{ to: "cancelled", reason: "scope dropped" }]);
    expect(await screen.findByText("This epic is cancelled; its state can no longer change.")).toBeTruthy();
    // The stories were refetched: the unfinished ones are cancelled, the finished one is untouched.
    await waitFor(() => expect(screen.getByText("1 of 3 stories finished, 2 cancelled")).toBeTruthy());
    const cards = Array.from(document.querySelectorAll(".cards .card")).map((c) => c.textContent ?? "");
    expect(cards.map((c) => (c.includes("cancelled") ? "cancelled" : c.includes("finished") ? "finished" : "other"))).toEqual(["finished", "cancelled", "cancelled"]);
  });

  it("says so when no story is affected, and words one story in the singular", async () => {
    setup({ state: "draft", stories: [login] });
    const first = renderAt();
    await screen.findByRole("heading", { name: "Auth" });
    fireEvent.click(button("Cancel epic")!);
    expect((await screen.findByRole("alertdialog")).textContent).toContain("No stories will change.");
    first.unmount();

    setup({ state: "draft", stories: [logout] });
    renderAt();
    await screen.findByRole("heading", { name: "Auth" });
    fireEvent.click(button("Cancel epic")!);
    expect((await screen.findByRole("alertdialog")).textContent).toContain("Its unfinished story will be cancelled too");
  });

  it("keeps the confirmation open and shows the error when cancelling fails", async () => {
    setup({ state: "draft", stories: [logout], transition: () => problem(500, "internal error", "database is on fire") });
    renderAt();
    await screen.findByRole("heading", { name: "Auth" });
    fireEvent.click(button("Cancel epic")!);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm cancel" }));
    expect((await screen.findByRole("alert")).textContent).toContain("database is on fire");
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });
});

describe("EpicPage errors", () => {
  it("reports an unknown epic", async () => {
    mockApi({
      "/api/v1/epics/9": problem(404, "not found", "epic 9: not found"),
      "/api/v1/epics/9/stories": problem(404, "not found", "x"),
      "/api/v1/epics/9/history": problem(404, "not found", "x"),
    });
    renderAt("/epics/9");
    expect(await screen.findByRole("heading", { name: "Epic not found" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to projects" }).getAttribute("href")).toBe("/");
  });

  it("treats a malformed id as unknown without calling the API", () => {
    const { calls } = setup();
    for (const bad of ["abc", "0", "1x"]) {
      const { unmount } = renderAt(`/epics/${bad}`);
      expect(screen.getByRole("heading", { name: "Epic not found" })).toBeTruthy();
      unmount();
    }
    expect(calls).toEqual([]);
  });

  it("shows server errors and recovers on retry", async () => {
    let healthy = false;
    mockApi({
      "/api/v1/epics/1": () => (healthy ? { ...epic({ id: 1, project_id: 1, name: "Auth" }), allowed_transitions: [] } : problem(500, "internal error", "database is on fire")),
      "/api/v1/epics/1/stories": [],
      "/api/v1/epics/1/history": [],
      "/api/v1/projects/1": project({ id: 1, name: "Alpha" }),
    });
    renderAt();
    expect((await screen.findByRole("alert")).textContent).toContain("database is on fire");
    healthy = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Auth" })).toBeTruthy();
  });

  it("shows a loading message first", async () => {
    setup();
    renderAt();
    expect(screen.getByText("Loading...")).toBeTruthy();
    await screen.findByRole("heading", { name: "Auth" });
  });
});
