import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import EpicPage from "./EpicPage";
import { epic, historyEntry, json, mockApi, problem, project, story, type HistoryEntry, type Story } from "../test/fixtures";

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
    writes: [] as { method: string; path: string; body: Record<string, unknown> }[],
  };
  const withWarnings = (s: Story): Story => ({ ...s, warnings: s.estimate_loc !== null && s.estimate_loc > 400 ? ["estimate_exceeds_400_loc"] : [] });
  const bodyOf = async (req: Request, path: string) => {
    const body = (await req.json()) as Record<string, unknown>;
    w.writes.push({ method: req.method, path, body });
    return body;
  };
  // Story endpoints answer like the real server: empty names are 422, finished/cancelled stories are 409.
  const storyRoutes = Object.fromEntries(
    [1, 2, 3, 4, 5].map((n) => [
      `/api/v1/stories/${n}`,
      async (req: Request) => {
        const body = await bodyOf(req, `/stories/${n}`);
        const current = w.stories.find((s) => s.id === n)!;
        if (current.state === "finished" || current.state === "cancelled") {
          return problem(409, "conflict", `story ${n} is ${current.state}: story is finished or cancelled and cannot be modified`);
        }
        if (typeof body.name === "string" && body.name.trim() === "") return problem(422, "validation failed", "name must not be empty");
        const updated = withWarnings({ ...current, ...(body as Partial<Story>) });
        w.stories = w.stories.map((s) => (s.id === n ? updated : s));
        return updated;
      },
    ]),
  );
  const view = () => ({ ...w.epic, allowed_transitions: allowed[w.epic.state as EpicState] });
  const server = mockApi({
    ...storyRoutes,
    "/api/v1/epics/1": async (req: Request) => {
      if (req.method === "PATCH") {
        const body = await bodyOf(req, "/epics/1");
        if (typeof body.name === "string" && body.name.trim() === "") return problem(422, "validation failed", "name must not be empty");
        w.epic = { ...w.epic, ...(body as Partial<typeof w.epic>) };
      }
      return view();
    },
    "/api/v1/epics/1/stories": async (req: Request) => {
      if (req.method !== "POST") return w.stories;
      const body = await bodyOf(req, "/epics/1/stories");
      if (w.epic.state === "finished" || w.epic.state === "cancelled") return problem(409, "conflict", `epic 1 is ${w.epic.state}: epic is finished or cancelled`);
      if (typeof body.name !== "string") return problem(422, "validation failed", "name is required");
      if (body.name.trim() === "") return problem(422, "validation failed", "name must not be empty");
      const created = withWarnings(story({ ...(body as Partial<Story>), id: Math.max(0, ...w.stories.map((s) => s.id)) + 1, epic_id: 1, project_id: 1, state: "draft" }));
      w.stories = [...w.stories, created];
      return json(created, 201);
    },
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
      expect(actionNames()).toEqual([]); // no state changes offered
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

describe("EpicPage forms", () => {
  const cardOf = (name: string) => screen.getByText(name).closest("li")!;

  it("edits the epic's name and description", async () => {
    const { w } = setup({ state: "ready" });
    renderAt();
    await screen.findByRole("heading", { name: "Auth" });

    fireEvent.click(screen.getByRole("button", { name: "Edit epic" }));
    const form = screen.getByRole("form", { name: "Edit epic" });
    expect((within(form).getByLabelText("Name") as HTMLInputElement).value).toBe("Auth");
    expect((within(form).getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Sign-in and sessions");
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Authentication" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save epic" }));

    expect(await screen.findByRole("heading", { name: "Authentication" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Edit epic" })).toBeNull();
    expect(w.writes).toEqual([{ method: "PATCH", path: "/epics/1", body: { name: "Authentication", description: "Sign-in and sessions" } }]);
  });

  it("leaves the epic unchanged when editing is cancelled", async () => {
    const { w } = setup();
    renderAt();
    await screen.findByRole("heading", { name: "Auth" });
    fireEvent.click(screen.getByRole("button", { name: "Edit epic" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "Auth" })).toBeTruthy();
    expect(w.writes).toHaveLength(0);
  });

  it("shows the server's message next to the epic form", async () => {
    setup();
    renderAt();
    await screen.findByRole("heading", { name: "Auth" });
    fireEvent.click(screen.getByRole("button", { name: "Edit epic" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save epic" }));
    const form = screen.getByRole("form", { name: "Edit epic" });
    expect((await within(form).findByRole("alert")).textContent).toContain("name must not be empty");
  });

  it("creates a story, warning about a big estimate while typing and showing the server's warning after", async () => {
    const { w } = setup({ state: "review", stories: [logout] });
    renderAt();
    await screen.findByRole("heading", { name: "Auth" });

    fireEvent.click(screen.getByRole("button", { name: "New story" }));
    const form = screen.getByRole("form", { name: "New story" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Reports" } });
    fireEvent.change(within(form).getByLabelText("Estimate (lines of code)"), { target: { value: "450" } });
    expect(within(form).getByText(/Estimate is over 400 lines/)).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: "Create story" }));

    await waitFor(() => expect(screen.queryByRole("form", { name: "New story" })).toBeNull());
    expect(w.writes[0]).toEqual({
      method: "POST",
      path: "/epics/1/stories",
      body: { name: "Reports", description: "", acceptance_criteria: "", assignee: "", estimate_loc: 450 },
    });
    const card = await waitFor(() => cardOf("Reports"));
    expect(card.textContent).toContain("draft");
    expect(card.textContent).toContain("450 LOC");
    expect(card.textContent).toContain("Estimate is over 400 lines; consider splitting the story"); // from the server's warning
    expect(screen.getByText("0 of 2 stories finished")).toBeTruthy();
  });

  it("shows the server's validation message next to the new-story form and keeps it open", async () => {
    setup();
    renderAt();
    await screen.findByRole("heading", { name: "Auth" });
    fireEvent.click(screen.getByRole("button", { name: "New story" }));
    fireEvent.click(screen.getByRole("button", { name: "Create story" }));
    const form = screen.getByRole("form", { name: "New story" });
    expect((await within(form).findByRole("alert")).textContent).toContain("name must not be empty");
    expect(screen.getByRole("form", { name: "New story" })).toBeTruthy();
  });

  it("offers no new stories in a finished or cancelled epic", async () => {
    for (const state of ["finished", "cancelled"] as const) {
      setup({ state, stories: [login] });
      const { unmount } = renderAt();
      await screen.findByRole("heading", { name: "Auth" });
      expect(screen.getByText(`This epic is ${state} and accepts no new stories.`)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "New story" })).toBeNull();
      expect(screen.getByRole("button", { name: "Edit epic" })).toBeTruthy(); // the epic itself stays editable
      unmount();
    }
  });

  it("edits a story in place", async () => {
    const { w } = setup({ state: "ready", stories: [login, logout] });
    renderAt();
    await screen.findByText("Logout");

    fireEvent.click(screen.getByRole("button", { name: "Edit Logout" }));
    const form = screen.getByRole("form", { name: "Edit story" });
    expect((within(form).getByLabelText("Name") as HTMLInputElement).value).toBe("Logout");
    fireEvent.change(within(form).getByLabelText("Assignee"), { target: { value: "carol" } });
    fireEvent.change(within(form).getByLabelText("Estimate (lines of code)"), { target: { value: "90" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save story" }));

    await waitFor(() => expect(screen.queryByRole("form", { name: "Edit story" })).toBeNull());
    expect(w.writes[0].path).toBe("/stories/2");
    expect(w.writes[0].body).toMatchObject({ name: "Logout", assignee: "carol", estimate_loc: 90 });
    await waitFor(() => expect(cardOf("Logout").textContent).toContain("carol"));
    expect(cardOf("Logout").textContent).toContain("90 LOC");
  });

  it("shows the server's message inside the story form", async () => {
    setup({ state: "ready", stories: [logout] });
    renderAt();
    await screen.findByText("Logout");
    fireEvent.click(screen.getByRole("button", { name: "Edit Logout" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: "Save story" }));
    const form = screen.getByRole("form", { name: "Edit story" });
    expect((await within(form).findByRole("alert")).textContent).toContain("name must not be empty");
  });

  it("presents finished and cancelled stories as read-only, with no edit button", async () => {
    const dropped = story({ id: 4, epic_id: 1, name: "Dropped", state: "cancelled" });
    setup({ state: "ready", stories: [login, logout, dropped] });
    renderAt();
    await screen.findByText("Logout");

    for (const name of ["Login", "Dropped"]) {
      expect(within(cardOf(name)).getByText("read-only")).toBeTruthy();
      expect(screen.queryByRole("button", { name: `Edit ${name}` })).toBeNull();
    }
    expect(screen.getByRole("button", { name: "Edit Logout" })).toBeTruthy();
    expect(within(cardOf("Logout")).queryByText("read-only")).toBeNull();
  });

  it("edits only one story at a time", async () => {
    setup({ state: "ready", stories: [logout, invoice] });
    renderAt();
    await screen.findByText("Logout");
    fireEvent.click(screen.getByRole("button", { name: "Edit Logout" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Invoice list" }));
    const forms = screen.getAllByRole("form", { name: "Edit story" });
    expect(forms).toHaveLength(1);
    expect((within(forms[0]).getByLabelText("Name") as HTMLInputElement).value).toBe("Invoice list");
  });
});
