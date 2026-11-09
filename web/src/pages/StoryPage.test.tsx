import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import StoryPage from "./StoryPage";
import { comment, epic, historyEntry, issue, json, mockApi, problem, pullRequest, story, storyDetail, storyRef, type Comment, type HistoryEntry, type Story, type StoryDetail } from "../test/fixtures";

type StoryState = StoryDetail["state"];

// What the server's story workflow allows from each state.
const allowed: Record<StoryState, StoryState[]> = {
  draft: ["review", "cancelled"],
  review: ["design", "cancelled"],
  design: ["implementation", "cancelled"],
  implementation: ["testing", "design", "cancelled"],
  testing: ["pr_review", "implementation", "design", "cancelled"],
  pr_review: ["finished", "design", "cancelled"],
  finished: [],
  cancelled: [],
};

interface Setup {
  story?: Partial<StoryDetail>;
  history?: HistoryEntry[];
  /** Answer the transition endpoint with this instead of applying the move. */
  transition?: (body: { to: string; reason?: string }) => Response | undefined;
  /** Other stories of the project (the dependency picker offers them). */
  others?: Story[];
  /** Answer the dependency endpoints with this instead of applying the change. */
  dependency?: (method: string, id: number) => Response | undefined;
  /** Answer a pull request removal with this instead of applying it. */
  removePullRequest?: (id: number) => Response | undefined;
  /** Whether GET /github-sync reports the sync as enabled. */
  githubSync?: boolean;
}

/** A small stateful fake of the story endpoints: a successful write changes what the next GET returns. */
function setup(init: Setup = {}) {
  const w = {
    story: storyDetail({ id: 1, epic_id: 1, project_id: 1, name: "Login", state: "draft", ...init.story }),
    history: init.history ?? [],
    posts: [] as { to: string; reason?: string }[],
    patches: [] as Record<string, unknown>[],
    deps: [] as { method: string; id: number }[],
    tagCalls: [] as string[],
    comments: [] as Comment[],
    commentPosts: [] as Record<string, unknown>[],
    prWrites: [] as { method: string; body: unknown }[],
    issueWrites: [] as { id: number; body: unknown }[],
  };
  const others = init.others ?? [];
  const view = () => ({ ...w.story, allowed_transitions: allowed[w.story.state as StoryState] });
  // PUT / DELETE /stories/1/dependencies/{n}: change the story's depends_on like the real server would.
  const depRoutes = Object.fromEntries(
    Array.from({ length: 11 }, (_, i) => i + 2).map((n) => [
      `/api/v1/stories/1/dependencies/${n}`,
      async (req: Request) => {
        w.deps.push({ method: req.method, id: n });
        const custom = init.dependency?.(req.method, n);
        if (custom) return custom;
        if (req.method === "PUT") {
          const target = others.find((s) => s.id === n)!;
          if (!w.story.depends_on.some((d) => d.id === n)) {
            w.story = { ...w.story, depends_on: [...w.story.depends_on, storyRef({ id: n, epic_id: target.epic_id, name: target.name, state: target.state })] };
          }
          return view();
        }
        w.story = { ...w.story, depends_on: w.story.depends_on.filter((d) => d.id !== n) };
        return new Response(null, { status: 204 });
      },
    ]),
  );
  const server = mockApi({
    ...depRoutes,
    "/api/v1/projects/1/stories": () => [w.story, ...others],
    "/api/v1/projects/1/epics": [epic({ id: 1, project_id: 1, name: "Auth" }), epic({ id: 2, project_id: 1, name: "Billing" })],
    "/api/v1/stories/1": async (req: Request) => {
      if (req.method === "PATCH") {
        const body = (await req.json()) as Record<string, unknown>;
        w.patches.push(body);
        w.story = { ...w.story, ...(body as Partial<StoryDetail>) };
      }
      return view();
    },
    "/api/v1/stories/1/history": () => w.history,
    // Comments: stateful, like the real server.
    "/api/v1/stories/1/comments": async (req: Request) => {
      if (req.method === "GET") return w.comments;
      const body = (await req.json()) as Record<string, unknown>;
      w.commentPosts.push(body);
      const created = comment({ id: w.comments.length + 1, body: String(body.body), author: String(body.author ?? "") });
      w.comments = [...w.comments, created];
      return json(created, 201);
    },
    "/api/v1/github-sync": { enabled: init.githubSync === true, last_run_at: null, last_error: "" },
    // Pull requests: only canonical github.com pull request URLs, no duplicates (like the real server).
    "/api/v1/stories/1/pull-requests": async (req: Request) => {
      const body = (await req.json()) as { github_url: string };
      w.prWrites.push({ method: "POST", body });
      const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(body.github_url);
      if (!m) return problem(422, "validation failed", `invalid GitHub pull request URL: expected https://github.com/{owner}/{repo}/pull/{number} (got ${body.github_url})`);
      if (w.story.pull_requests.some((p) => p.github_url === body.github_url)) return problem(409, "conflict", "pull request is already linked: already exists");
      const created = pullRequest({ id: Math.max(0, ...w.story.pull_requests.map((p) => p.id)) + 1, github_url: body.github_url, github_repo: `${m[1]}/${m[2]}`, number: Number(m[3]) });
      w.story = { ...w.story, pull_requests: [...w.story.pull_requests, created] };
      return json(created, 201);
    },
    ...Object.fromEntries(
      [1, 2, 3, 4, 5].map((n) => [
        `/api/v1/stories/1/pull-requests/${n}`,
        async (req: Request) => {
          w.prWrites.push({ method: req.method, body: n });
          const refused = init.removePullRequest?.(n);
          if (refused) return refused;
          w.story = { ...w.story, pull_requests: w.story.pull_requests.filter((p) => p.id !== n) };
          return new Response(null, { status: 204 });
        },
      ]),
    ),
    // Unlinking an issue: PATCH /issues/{n} with story_id null.
    ...Object.fromEntries(
      [1, 2, 3].map((n) => [
        `/api/v1/issues/${n}`,
        async (req: Request) => {
          w.issueWrites.push({ id: n, body: await req.json() });
          w.story = { ...w.story, issues: w.story.issues.filter((i) => i.id !== n) };
          return issue({ id: n, story_id: null });
        },
      ]),
    ),
    // Tags: "newtag" can be added, "backend" removed.
    "/api/v1/stories/1/tags/newtag": async (req: Request) => {
      w.tagCalls.push(req.method);
      w.story = { ...w.story, tags: [...w.story.tags, "newtag"] };
      return view();
    },
    "/api/v1/stories/1/tags/backend": async (req: Request) => {
      w.tagCalls.push(req.method);
      w.story = { ...w.story, tags: w.story.tags.filter((t) => t !== "backend") };
      return new Response(null, { status: 204 });
    },
    "/api/v1/epics/1": { ...epic({ id: 1, project_id: 1, name: "Auth" }), allowed_transitions: [] },
    "/api/v1/stories/1/transition": async (req: Request) => {
      const body = (await req.json()) as { to: string; reason?: string };
      w.posts.push(body);
      const custom = init.transition?.(body);
      if (custom) return custom;
      const from = w.story.state;
      w.story = { ...w.story, state: body.to as StoryState };
      w.history = [...w.history, historyEntry({ id: w.history.length + 1, entity_type: "story", entity_id: 1, from_state: from, to_state: body.to, reason: body.reason ?? "" })];
      return view();
    },
  });
  return { w, ...server };
}

function renderAt(url = "/stories/1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, ...render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/stories/:storyId" element={<StoryPage />} />
          <Route path="/" element={<p>home</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ) };
}

const button = (name: string | RegExp) => screen.queryByRole("button", { name });
const panelButtons = () => within(screen.getByRole("region", { name: "Change state" })).queryAllByRole("button").map((b) => b.textContent);
const loaded = () => screen.findByRole("heading", { name: "Login" });

describe("StoryPage content", () => {
  it("shows the story with its epic, fields, dependencies and history", async () => {
    setup({
      story: {
        state: "implementation",
        description: "A login form",
        acceptance_criteria: "Users can sign in",
        assignee: "ann",
        estimate_loc: 450,
        warnings: ["estimate_exceeds_400_loc"],
        tags: ["backend", "api"],
        depends_on: [storyRef({ id: 5, name: "Sessions", state: "finished" })],
        dependents: [storyRef({ id: 6, name: "Logout", state: "draft" })],
      },
      history: [
        historyEntry({ id: 1, from_state: "draft", to_state: "review", reason: "ready", actor: "ann", at: "2026-01-02T03:04:05.000Z" }),
        historyEntry({ id: 2, from_state: "review", to_state: "design", at: "2026-01-03T10:00:00.000Z" }),
      ],
    });
    renderAt();

    expect(await loaded()).toBeTruthy();
    expect((await screen.findByRole("link", { name: /Auth/ })).getAttribute("href")).toBe("/epics/1");
    expect(screen.getByText("Story #1")).toBeTruthy();
    const dl = document.querySelector("dl.fields")!.textContent ?? "";
    for (const text of ["A login form", "Users can sign in", "ann", "450 lines of code", "Estimate is over 400 lines"]) {
      expect(dl).toContain(text);
    }
    const tagsText = screen.getByRole("region", { name: "Tags" }).textContent ?? "";
    expect(tagsText).toContain("backend");
    expect(tagsText).toContain("api");

    // Both directions of the dependency relation, as links with states.
    const sessions = screen.getByRole("link", { name: "#5 Sessions" });
    expect(sessions.getAttribute("href")).toBe("/stories/5");
    expect(sessions.closest("li")!.textContent).toContain("finished");
    const logout = screen.getByRole("link", { name: "#6 Logout" });
    expect(logout.getAttribute("href")).toBe("/stories/6");
    expect(logout.closest("li")!.textContent).toContain("draft");

    // Each relation sits under its own heading (not swapped).
    const under = (heading: string) => screen.getByRole("heading", { name: heading }).nextElementSibling!.textContent ?? "";
    expect(under("Depends on")).toContain("Sessions");
    expect(under("Depends on")).not.toContain("Logout");
    expect(under("Required by")).toContain("Logout");
    expect(under("Required by")).not.toContain("Sessions");

    // History newest first, ending with creation.
    const items = within(screen.getByRole("list", { name: "State history" })).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("2026-01-03 10:00 UTC");
    expect(items[1].textContent).toContain("by ann");
    expect(items[1].textContent).toContain("ready");
    expect(items[2].textContent).toContain("Created");
  });

  it("says what is missing instead of showing blanks", async () => {
    setup();
    renderAt();
    await loaded();
    expect(screen.getByText("No description.")).toBeTruthy();
    expect(screen.getByText("None recorded.")).toBeTruthy();
    expect(screen.getByText("unassigned")).toBeTruthy();
    expect(screen.getByText("No estimate")).toBeTruthy();
    expect(screen.getByText("This story depends on no other story.")).toBeTruthy();
    expect(screen.getByText("No story depends on this one.")).toBeTruthy();
    expect(screen.getByText("No tags yet.")).toBeTruthy();
    expect(await screen.findByText("No comments yet.")).toBeTruthy();
  });

  it("does not warn about an estimate within the limit", async () => {
    setup({ story: { estimate_loc: 400 } });
    renderAt();
    await loaded();
    expect(screen.getByText("400 lines of code")).toBeTruthy();
    expect(screen.queryByText(/over 400 lines/)).toBeNull();
  });
});

describe("StoryPage state changes", () => {
  it("offers exactly the moves the server allows, labelling the backward ones", async () => {
    const expected: [StoryState, string[]][] = [
      ["draft", ["Move to review", "Cancel story"]],
      ["design", ["Move to implementation", "Cancel story"]],
      ["implementation", ["Move to testing", "Move back to design", "Cancel story"]],
      ["testing", ["Move to pr_review", "Move back to implementation", "Move back to design", "Cancel story"]],
      ["pr_review", ["Move to finished", "Move back to design", "Cancel story"]],
    ];
    for (const [state, labels] of expected) {
      setup({ story: { state } });
      const { unmount } = renderAt();
      await loaded();
      expect(panelButtons(), state).toEqual(labels);
      unmount();
    }
  });

  it("moves the story with a reason and refreshes the page", async () => {
    const { w } = setup({ story: { state: "design" } });
    renderAt();
    await loaded();

    fireEvent.change(screen.getByLabelText("Reason (optional)"), { target: { value: "design agreed" } });
    fireEvent.click(button("Move to implementation")!);

    expect((await screen.findByRole("status")).textContent).toBe("Story moved to implementation.");
    expect(w.posts).toEqual([{ to: "implementation", reason: "design agreed" }]);
    await waitFor(() => expect(panelButtons()).toEqual(["Move to testing", "Move back to design", "Cancel story"]));
    expect((screen.getByLabelText("Reason (optional)") as HTMLInputElement).value).toBe("");
    await waitFor(() => expect(within(screen.getByRole("list", { name: "State history" })).getAllByRole("listitem")).toHaveLength(2));
  });

  it("refreshes the story, its epic's progress and its project's board after a move", async () => {
    setup({ story: { state: "draft", epic_id: 1, project_id: 1 } });
    const { client } = renderAt();
    await loaded();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fireEvent.click(button("Move to review")!);
    await screen.findByRole("status");
    const keys = invalidate.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toEqual(expect.arrayContaining(['["story",1]', '["epic",1]', '["project",1]']));
  });

  it("can move a story backwards", async () => {
    const { w } = setup({ story: { state: "testing" } });
    renderAt();
    await loaded();
    fireEvent.click(button("Move back to design")!);
    await screen.findByRole("status");
    expect(w.posts).toEqual([{ to: "design" }]);
    await waitFor(() => expect(panelButtons()).toEqual(["Move to implementation", "Cancel story"]));
  });

  it("shows the server's explanation when the epic is not far enough along", async () => {
    const detail = "transition blocked: a story can move to review only while its epic is review or ready (epic is draft)";
    const { w } = setup({ transition: () => problem(409, "conflict", detail) });
    renderAt();
    await loaded();
    fireEvent.click(button("Move to review")!);
    expect((await screen.findByRole("alert")).textContent).toContain("only while its epic is review or ready (epic is draft)");
    expect(w.story.state).toBe("draft");
    expect(panelButtons()).toEqual(["Move to review", "Cancel story"]); // nothing changed
  });

  it("shows the server's explanation when dependencies are unfinished", async () => {
    const detail = 'transition blocked: a story can finish only when the stories it depends on are finished: #5 "Sessions" (testing)';
    const { w } = setup({ story: { state: "pr_review", depends_on: [storyRef({ id: 5, name: "Sessions", state: "pr_review" })] }, transition: () => problem(409, "conflict", detail) });
    renderAt();
    await loaded();
    fireEvent.click(button("Move to finished")!);
    expect((await screen.findByRole("alert")).textContent).toContain('#5 "Sessions" (testing)');
    expect(w.story.state).toBe("pr_review");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("asks before cancelling and names the live stories waiting on this one", async () => {
    const { w } = setup({
      story: {
        state: "implementation",
        dependents: [
          storyRef({ id: 6, name: "Logout", state: "draft" }),
          storyRef({ id: 7, name: "Reports", state: "design" }),
          storyRef({ id: 8, name: "Old", state: "cancelled" }),
        ],
      },
    });
    renderAt();
    await loaded();

    fireEvent.click(button("Cancel story")!);
    const dialog = await screen.findByRole("alertdialog", { name: "Confirm cancelling the story" });
    expect(dialog.textContent).toContain("A cancelled story is final and cannot be reopened");
    expect(dialog.textContent).toContain("These 2 stories are waiting on it");
    const listed = within(dialog).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(listed.some((t) => t.includes("Logout"))).toBe(true);
    expect(listed.some((t) => t.includes("Reports"))).toBe(true);
    expect(listed.some((t) => t.includes("Old"))).toBe(false); // already cancelled: not waiting
    expect(w.posts).toHaveLength(0);

    fireEvent.click(button("Keep story")!);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(w.posts).toHaveLength(0);

    fireEvent.click(button("Cancel story")!);
    fireEvent.change(screen.getByLabelText("Reason (optional)"), { target: { value: "no longer needed" } });
    fireEvent.click(await screen.findByRole("button", { name: "Confirm cancel" }));
    expect((await screen.findByRole("status")).textContent).toBe("Story moved to cancelled.");
    expect(w.posts).toEqual([{ to: "cancelled", reason: "no longer needed" }]);
  });

  it("keeps the cancel confirmation simple when nothing waits on the story", async () => {
    setup({ story: { state: "draft" } });
    renderAt();
    await loaded();
    fireEvent.click(button("Cancel story")!);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("can no longer be edited or moved");
    expect(within(dialog).queryAllByRole("listitem")).toHaveLength(0);
  });
});

describe("StoryPage read-only stories", () => {
  for (const state of ["finished", "cancelled"] as const) {
    it(`presents a ${state} story as read-only`, async () => {
      setup({ story: { state, description: "Still readable", assignee: "ann" } });
      renderAt();
      await loaded();
      expect(screen.getByText("read-only")).toBeTruthy();
      expect(button("Edit story")).toBeNull();
      expect(screen.getByText(`This story is ${state}; its state can no longer change.`)).toBeTruthy();
      expect(panelButtons()).toEqual([]);
      expect(screen.getByText("Still readable")).toBeTruthy(); // the content is still there
    });
  }

  it("turns read-only once the story is cancelled from the page", async () => {
    setup({ story: { state: "review" } });
    renderAt();
    await loaded();
    expect(button("Edit story")).toBeTruthy();
    fireEvent.click(button("Cancel story")!);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm cancel" }));
    await waitFor(() => expect(screen.getByText("read-only")).toBeTruthy());
    expect(button("Edit story")).toBeNull();
    expect(panelButtons()).toEqual([]);
  });
});

describe("StoryPage editing", () => {
  it("edits the story with the shared form and refreshes the page", async () => {
    const { w } = setup({ story: { assignee: "ann", estimate_loc: 120, description: "d", acceptance_criteria: "ac" } });
    renderAt();
    await loaded();

    fireEvent.click(button("Edit story")!);
    const form = screen.getByRole("form", { name: "Edit story" });
    expect((within(form).getByLabelText("Assignee") as HTMLInputElement).value).toBe("ann");
    fireEvent.change(within(form).getByLabelText("Assignee"), { target: { value: "carol" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save story" }));

    await waitFor(() => expect(screen.queryByRole("form", { name: "Edit story" })).toBeNull());
    expect(w.patches).toEqual([{ name: "Login", description: "d", acceptance_criteria: "ac", assignee: "carol", estimate_loc: 120 }]);
    expect(await screen.findByText("carol")).toBeTruthy();
  });

  it("can be cancelled without saving", async () => {
    const { w } = setup();
    renderAt();
    await loaded();
    fireEvent.click(button("Edit story")!);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Edit story" })).toBeNull();
    expect(w.patches).toHaveLength(0);
  });
});

describe("StoryPage errors", () => {
  it("reports an unknown story", async () => {
    mockApi({ "/api/v1/stories/9": problem(404, "not found", "story 9: not found"), "/api/v1/stories/9/history": problem(404, "not found", "x") });
    renderAt("/stories/9");
    expect(await screen.findByRole("heading", { name: "Story not found" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to projects" }).getAttribute("href")).toBe("/");
  });

  it("treats a malformed id as unknown without calling the API", () => {
    const { calls } = setup();
    for (const bad of ["abc", "0", "1x"]) {
      const { unmount } = renderAt(`/stories/${bad}`);
      expect(screen.getByRole("heading", { name: "Story not found" })).toBeTruthy();
      unmount();
    }
    expect(calls).toEqual([]);
  });

  it("shows server errors and recovers on retry", async () => {
    let healthy = false;
    mockApi({
      "/api/v1/stories/1": () => (healthy ? { ...storyDetail({ id: 1, name: "Login" }), allowed_transitions: [] } : problem(500, "internal error", "database is on fire")),
      "/api/v1/stories/1/history": [],
      "/api/v1/stories/1/comments": [],
      "/api/v1/epics/1": { ...epic({ id: 1, name: "Auth" }), allowed_transitions: [] },
      "/api/v1/projects/1/stories": [],
      "/api/v1/projects/1/epics": [],
    });
    renderAt();
    expect((await screen.findByRole("alert")).textContent).toContain("database is on fire");
    healthy = true;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await loaded()).toBeTruthy();
  });

  it("still shows the page when only the history fails", async () => {
    mockApi({
      "/api/v1/stories/1": { ...storyDetail({ id: 1, name: "Login" }), allowed_transitions: ["review", "cancelled"] },
      "/api/v1/stories/1/history": problem(500, "internal error", "history is broken"),
      "/api/v1/stories/1/comments": [],
      "/api/v1/epics/1": { ...epic({ id: 1, name: "Auth" }), allowed_transitions: [] },
      "/api/v1/projects/1/stories": [],
      "/api/v1/projects/1/epics": [],
    });
    renderAt();
    await loaded();
    expect((await screen.findByRole("alert")).textContent).toContain("history is broken");
    expect(button("Move to review")).toBeTruthy();
  });

  it("falls back to a generic back link when the epic cannot be loaded", async () => {
    mockApi({
      "/api/v1/stories/1": { ...storyDetail({ id: 1, epic_id: 4, name: "Login" }), allowed_transitions: [] },
      "/api/v1/stories/1/history": [],
      "/api/v1/stories/1/comments": [],
      "/api/v1/epics/4": problem(500, "internal error", "x"),
      "/api/v1/projects/1/stories": [],
      "/api/v1/projects/1/epics": [],
    });
    renderAt();
    await loaded();
    const back = screen.getByRole("link", { name: /Epic/ });
    expect(back.getAttribute("href")).toBe("/epics/4");
  });

  it("shows a loading message first", async () => {
    setup();
    renderAt();
    expect(screen.getByText("Loading...")).toBeTruthy();
    await loaded();
  });
});

describe("StoryPage dependencies", () => {
  const sessions = story({ id: 2, epic_id: 1, project_id: 1, name: "Sessions", state: "finished" });
  const emails = story({ id: 3, epic_id: 1, project_id: 1, name: "Emails", state: "implementation" });
  const invoices = story({ id: 4, epic_id: 2, project_id: 1, name: "Invoices", state: "draft" });
  const reports = story({ id: 5, epic_id: 2, project_id: 1, name: "Reports", state: "cancelled" });
  const foreign = story({ id: 6, epic_id: 9, project_id: 2, name: "Other project", state: "draft" });
  const logout = storyRef({ id: 7, epic_id: 1, name: "Logout", state: "draft" });
  const options = () => within(screen.getByLabelText("Story to depend on")).getAllByRole("option").map((o) => o.textContent);
  const choose = (id: number) => fireEvent.change(screen.getByLabelText("Story to depend on"), { target: { value: String(id) } });
  const add = () => fireEvent.click(screen.getByRole("button", { name: "Add dependency" }));
  const pickerReady = () => screen.findByRole("form", { name: "Add dependency" });
  const dependsOn = () => screen.getByRole("heading", { name: "Depends on" }).nextElementSibling!;

  it("lists dependencies with a Remove button each, and flags a cancelled one", async () => {
    setup({ story: { state: "design", depends_on: [storyRef({ id: 2, name: "Sessions", state: "finished" }), storyRef({ id: 5, name: "Reports", state: "cancelled" })], dependents: [logout] }, others: [sessions, reports] });
    renderAt();
    await loaded();

    expect(within(dependsOn() as HTMLElement).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Remove dependency on #2 Sessions",
      "Remove dependency on #5 Reports",
    ]);
    const hints = within(dependsOn() as HTMLElement).getAllByText(/Cancelled: this story cannot finish/);
    expect(hints).toHaveLength(1);
    expect(hints[0].closest("li")!.textContent).toContain("Reports"); // only the cancelled one is flagged
    // "Required by" is read-only.
    const requiredBy = screen.getByRole("heading", { name: "Required by" }).nextElementSibling!;
    expect(within(requiredBy as HTMLElement).queryAllByRole("button")).toHaveLength(0);
    expect(requiredBy.textContent).toContain("Logout");
  });

  it("removes a dependency, a cancelled one included, and refreshes the lists", async () => {
    const { w } = setup({ story: { state: "testing", depends_on: [storyRef({ id: 5, name: "Reports", state: "cancelled" })] }, others: [reports] });
    renderAt();
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: "Remove dependency on #5 Reports" }));
    await waitFor(() => expect(screen.getByText("This story depends on no other story.")).toBeTruthy());
    expect(w.deps).toEqual([{ method: "DELETE", id: 5 }]);
    // The removed story is a candidate again.
    expect(options()).toContain("#5 Reports (cancelled)");
  });

  it("shows the server's message when a removal is refused", async () => {
    setup({
      story: { state: "design", depends_on: [storyRef({ id: 2, name: "Sessions", state: "finished" })] },
      others: [sessions],
      dependency: (method) => (method === "DELETE" ? problem(409, "conflict", "story 1 is finished: story is finished or cancelled and cannot be modified") : undefined),
    });
    renderAt();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Remove dependency on #2 Sessions" }));
    expect((await screen.findByRole("alert")).textContent).toContain("cannot be modified");
    expect(screen.getByRole("link", { name: "#2 Sessions" })).toBeTruthy(); // still listed
  });

  it("offers only free stories of the project, grouped by epic, with their states", async () => {
    setup({
      story: { state: "design", depends_on: [storyRef({ id: 2, name: "Sessions", state: "finished" })], dependents: [logout] },
      others: [sessions, emails, invoices, reports, foreign, story({ id: 7, epic_id: 1, project_id: 1, name: "Logout" })],
    });
    renderAt();
    await loaded();
    await pickerReady();

    expect(options()).toEqual(["Choose a story...", "#3 Emails (implementation)", "#4 Invoices (draft)", "#5 Reports (cancelled)"]);
    const groups = Array.from(document.querySelectorAll("optgroup")).map((g) => g.getAttribute("label"));
    expect(groups).toEqual(["Auth", "Billing"]);
    // Not the story itself (#1), its dependency (#2), its dependent (#7) or another project's story (#6).
    expect(options().join(" ")).not.toMatch(/#1 |#2 |#6 |#7 /);
  });

  it("adds the chosen dependency and refreshes the lists", async () => {
    const { w } = setup({ story: { state: "design" }, others: [sessions, emails] });
    renderAt();
    await loaded();
    await pickerReady();

    const addButton = screen.getByRole("button", { name: "Add dependency" }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true); // nothing chosen yet
    choose(3);
    expect(addButton.disabled).toBe(false);
    add();

    await waitFor(() => expect(within(dependsOn() as HTMLElement).getByRole("link", { name: "#3 Emails" })).toBeTruthy());
    expect(w.deps).toEqual([{ method: "PUT", id: 3 }]);
    expect((screen.getByLabelText("Story to depend on") as HTMLSelectElement).value).toBe(""); // reset
    expect(options()).toEqual(["Choose a story...", "#2 Sessions (finished)"]); // no longer offered
  });

  it("explains a refused dependency (a cycle) and lets the user pick again", async () => {
    const cycle = "story 1 -> 3: dependency would create a cycle";
    setup({ story: { state: "design" }, others: [emails, invoices], dependency: (method, id) => (method === "PUT" && id === 3 ? problem(409, "conflict", cycle) : undefined) });
    renderAt();
    await loaded();
    await pickerReady();

    choose(3);
    add();
    expect((await screen.findByRole("alert")).textContent).toContain("would create a cycle");
    expect((screen.getByLabelText("Story to depend on") as HTMLSelectElement).value).toBe("3"); // choice kept
    expect(within(dependsOn() as HTMLElement).queryByRole("link", { name: "#3 Emails" })).toBeNull();

    choose(4); // picking something else dismisses the stale message
    expect(screen.queryByRole("alert")).toBeNull();
    add();
    await waitFor(() => expect(within(dependsOn() as HTMLElement).getByRole("link", { name: "#4 Invoices" })).toBeTruthy());
  });

  it("explains a cross-project refusal too", async () => {
    setup({ story: { state: "design" }, others: [emails], dependency: () => problem(422, "validation failed", "stories 1 and 3: stories must belong to the same project") });
    renderAt();
    await loaded();
    await pickerReady();
    choose(3);
    add();
    expect((await screen.findByRole("alert")).textContent).toContain("must belong to the same project");
  });

  it("disables the form while the request is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { w } = setup({ story: { state: "design" }, others: [emails], dependency: undefined });
    // Hold the PUT back to observe the in-flight state.
    mockApi({
      "/api/v1/stories/1": { ...storyDetail({ id: 1, epic_id: 1, project_id: 1, name: "Login", state: "design" }), allowed_transitions: [] },
      "/api/v1/stories/1/history": [],
      "/api/v1/stories/1/comments": [],
      "/api/v1/epics/1": { ...epic({ id: 1, name: "Auth" }), allowed_transitions: [] },
      "/api/v1/projects/1/stories": [emails],
      "/api/v1/projects/1/epics": [epic({ id: 1, project_id: 1, name: "Auth" })],
      "/api/v1/stories/1/dependencies/3": async () => { w.deps.push({ method: "PUT", id: 3 }); await gate; return { ...storyDetail({ id: 1 }), allowed_transitions: [] }; },
    });
    renderAt();
    await loaded();
    await pickerReady();
    choose(3);
    add();
    await waitFor(() => expect((screen.getByRole("button", { name: "Add dependency" }) as HTMLButtonElement).disabled).toBe(true));
    add();
    release();
    await waitFor(() => expect(w.deps).toHaveLength(1));
  });

  it("refreshes every cached story page after a change (both ends of the relation)", async () => {
    setup({ story: { state: "design" }, others: [emails] });
    const { client } = renderAt();
    await loaded();
    await pickerReady();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    choose(3);
    add();
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(invalidate.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey))).toContain('["story"]');
  });

  it("is read-only for finished and cancelled stories", async () => {
    for (const state of ["finished", "cancelled"] as const) {
      const { calls } = setup({ story: { state, depends_on: [storyRef({ id: 2, name: "Sessions", state: "finished" })] }, others: [sessions, emails] });
      const { unmount } = renderAt();
      await loaded();
      expect(screen.getByText(`The dependencies of a ${state} story can no longer be changed.`)).toBeTruthy();
      expect(screen.queryByRole("form", { name: "Add dependency" })).toBeNull();
      expect(screen.queryByRole("button", { name: /Remove dependency/ })).toBeNull();
      expect(screen.getByRole("link", { name: "#2 Sessions" })).toBeTruthy(); // still shown
      expect(calls.some((c) => c.startsWith("/api/v1/projects/"))).toBe(false); // candidates are not even requested
      unmount();
    }
  });

  it("says so when there is nothing to depend on", async () => {
    setup({ story: { state: "design" }, others: [] });
    renderAt();
    await loaded();
    expect(await screen.findByText("There is no other story this one could depend on.")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Add dependency" })).toBeNull();
  });

  it("reports a failure to load the project's stories without hiding the dependencies", async () => {
    mockApi({
      "/api/v1/stories/1": { ...storyDetail({ id: 1, epic_id: 1, project_id: 1, name: "Login", state: "design", depends_on: [storyRef({ id: 2, name: "Sessions", state: "finished" })] }), allowed_transitions: [] },
      "/api/v1/stories/1/history": [],
      "/api/v1/stories/1/comments": [],
      "/api/v1/epics/1": { ...epic({ id: 1, name: "Auth" }), allowed_transitions: [] },
      "/api/v1/projects/1/stories": problem(500, "internal error", "stories are broken"),
      "/api/v1/projects/1/epics": [],
    });
    renderAt();
    await loaded();
    expect((await screen.findByRole("alert")).textContent).toContain("stories are broken");
    expect(screen.getByRole("link", { name: "#2 Sessions" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Add dependency" })).toBeNull();
  });
});

describe("StoryPage tags and comments", () => {
  const tagNames = () => within(screen.getByRole("region", { name: "Tags" })).queryAllByRole("listitem").map((li) => li.textContent?.replace("×", "").trim());

  it("shows the tags as links that filter the project's board, and the comments oldest first", async () => {
    const { w } = setup({ story: { tags: ["backend", "api"] } });
    w.comments = [comment({ id: 1, author: "ann", body: "First" }), comment({ id: 2, author: "bob", body: "Second" })];
    renderAt();
    await loaded();
    expect(screen.getByRole("link", { name: "backend" }).getAttribute("href")).toBe("/projects/1?tag=backend");
    const thread = await screen.findByRole("list", { name: "Comment thread" });
    expect(within(thread).getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining("First"), expect.stringContaining("Second")]);
  });

  for (const state of ["finished", "cancelled"] as const) {
    it(`keeps tags and comments usable on a ${state} story`, async () => {
      const { w } = setup({ story: { state, tags: ["backend"] } });
      renderAt();
      await loaded();
      expect(button("Edit story")).toBeNull(); // the story itself is read-only...

      // ...but tags can be added and removed...
      fireEvent.change(screen.getByLabelText("New tag"), { target: { value: "newtag" } });
      fireEvent.click(screen.getByRole("button", { name: "Add tag" }));
      await waitFor(() => expect(tagNames()).toEqual(["backend", "newtag"]));
      fireEvent.click(screen.getByRole("button", { name: "Remove tag backend" }));
      await waitFor(() => expect(tagNames()).toEqual(["newtag"]));
      expect(w.tagCalls).toEqual(["PUT", "DELETE"]);

      // ...and comments can be added.
      fireEvent.change(screen.getByLabelText("Author"), { target: { value: "ann" } });
      fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Retrospective note" } });
      fireEvent.click(screen.getByRole("button", { name: "Add comment" }));
      const thread = await screen.findByRole("list", { name: "Comment thread" });
      expect(thread.textContent).toContain("Retrospective note");
      expect(w.commentPosts).toEqual([{ body: "Retrospective note", author: "ann" }]);
    });
  }
});

describe("StoryPage pull requests", () => {
  const prs = [pullRequest({ id: 1, github_repo: "acme/widgets", number: 7, github_url: "https://github.com/acme/widgets/pull/7" }), pullRequest({ id: 2, github_repo: "acme/gadgets", number: 12, github_url: "https://github.com/acme/gadgets/pull/12" })];
  const section = () => screen.getByRole("region", { name: "Pull requests" });
  const urlField = () => screen.getByLabelText("GitHub pull request URL") as HTMLInputElement;
  const link = () => screen.getByRole("button", { name: "Link pull request" }) as HTMLButtonElement;

  it("lists the pull requests as links to GitHub, each removable", async () => {
    setup({ story: { state: "design", pull_requests: prs } });
    renderAt();
    await loaded();
    const first = within(section()).getByRole("link", { name: "acme/widgets#7" });
    expect(first.getAttribute("href")).toBe("https://github.com/acme/widgets/pull/7");
    expect(first.getAttribute("target")).toBe("_blank");
    expect(first.getAttribute("rel")).toContain("noopener");
    expect(within(section()).getAllByRole("button", { name: /^Remove pull request/ })).toHaveLength(2);
  });

  it("says when there are none", async () => {
    setup({ story: { state: "design" } });
    renderAt();
    await loaded();
    expect(within(section()).getByText("No pull requests linked.")).toBeTruthy();
  });

  it("links a pull request, clears the field and shows the new one", async () => {
    const { w } = setup({ story: { state: "implementation" } });
    renderAt();
    await loaded();
    expect(link().disabled).toBe(true); // nothing typed
    fireEvent.change(urlField(), { target: { value: "https://github.com/acme/widgets/pull/99" } });
    fireEvent.click(link());
    await waitFor(() => expect(within(section()).getByRole("link", { name: "acme/widgets#99" })).toBeTruthy());
    expect(w.prWrites).toEqual([{ method: "POST", body: { github_url: "https://github.com/acme/widgets/pull/99" } }]);
    expect(urlField().value).toBe("");
  });

  it("shows the server's message when the URL is refused, keeps the text, and dismisses it when typing", async () => {
    const { w } = setup({ story: { state: "implementation" } });
    renderAt();
    await loaded();
    fireEvent.change(urlField(), { target: { value: "https://github.com/acme/widgets/issues/5" } }); // an issue, not a PR
    fireEvent.click(link());
    expect((await within(section()).findByRole("alert")).textContent).toContain("invalid GitHub pull request URL");
    expect(urlField().value).toBe("https://github.com/acme/widgets/issues/5");
    expect(w.story.pull_requests).toHaveLength(0);
    fireEvent.change(urlField(), { target: { value: "https://github.com/acme/widgets/pull/5" } });
    expect(within(section()).queryByRole("alert")).toBeNull();
  });

  it("shows the server's message for a duplicate", async () => {
    setup({ story: { state: "implementation", pull_requests: prs } });
    renderAt();
    await loaded();
    fireEvent.change(urlField(), { target: { value: "https://github.com/acme/widgets/pull/7" } });
    fireEvent.click(link());
    expect((await within(section()).findByRole("alert")).textContent).toContain("already");
  });

  it("removes a pull request", async () => {
    const { w } = setup({ story: { state: "implementation", pull_requests: prs } });
    renderAt();
    await loaded();
    fireEvent.click(within(section()).getByRole("button", { name: "Remove pull request acme/widgets#7" }));
    await waitFor(() => expect(within(section()).queryByRole("link", { name: "acme/widgets#7" })).toBeNull());
    expect(within(section()).getByRole("link", { name: "acme/gadgets#12" })).toBeTruthy();
    expect(w.prWrites).toEqual([{ method: "DELETE", body: 1 }]);
  });

  it("shows the server's message when removing fails", async () => {
    setup({ story: { state: "implementation", pull_requests: prs }, removePullRequest: () => problem(500, "internal error", "database is on fire") });
    renderAt();
    await loaded();
    fireEvent.click(within(section()).getByRole("button", { name: "Remove pull request acme/widgets#7" }));
    expect((await within(section()).findByRole("alert")).textContent).toContain("database is on fire");
    expect(within(section()).getByRole("link", { name: "acme/widgets#7" })).toBeTruthy();
  });

  for (const state of ["finished", "cancelled"] as const) {
    it(`is read-only on a ${state} story: the links are shown, nothing can be added or removed`, async () => {
      setup({ story: { state, pull_requests: prs } });
      renderAt();
      await loaded();
      expect(within(section()).getByRole("link", { name: "acme/widgets#7" })).toBeTruthy();
      expect(within(section()).getByRole("link", { name: "acme/gadgets#12" })).toBeTruthy();
      expect(within(section()).queryAllByRole("button")).toHaveLength(0);
      expect(screen.queryByRole("form", { name: "Link pull request" })).toBeNull();
      expect(within(section()).getByText(`The pull request links of a ${state} story can no longer be changed.`)).toBeTruthy();
    });
  }

  it("refreshes the story after a change", async () => {
    setup({ story: { state: "implementation" } });
    const { client } = renderAt();
    await loaded();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fireEvent.change(urlField(), { target: { value: "https://github.com/acme/widgets/pull/3" } });
    fireEvent.click(link());
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(invalidate.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey))).toContain('["story",1]');
  });
});

describe("StoryPage issues", () => {
  const issues = [
    issue({ id: 1, story_id: 1, github_repo: "acme/widgets", number: 42, title: "Crash on save", kind: "bug", github_url: "https://github.com/acme/widgets/issues/42" }),
    issue({ id: 2, story_id: 1, github_repo: "acme/widgets", number: 43, github_url: "https://github.com/acme/widgets/issues/43" }),
  ];
  const section = () => screen.getByRole("region", { name: "Issues" });

  it("lists the linked issues with a link to GitHub, title and kind, and a link to manage them", async () => {
    setup({ story: { state: "design", issues } });
    renderAt();
    await loaded();
    const first = within(section()).getByRole("link", { name: "acme/widgets#42" });
    expect(first.getAttribute("href")).toBe("https://github.com/acme/widgets/issues/42");
    expect(first.getAttribute("target")).toBe("_blank");
    expect(first.closest("li")!.textContent).toContain("Crash on save");
    expect(first.closest("li")!.textContent).toContain("bug");
    expect(within(section()).getByRole("link", { name: "Manage this project's issues" }).getAttribute("href")).toBe("/projects/1/issues?story=1");
  });

  it("says when no issue is linked", async () => {
    setup({ story: { state: "design" } });
    renderAt();
    await loaded();
    expect(within(section()).getByText("No issues linked.")).toBeTruthy();
  });

  it("unlinks an issue and refreshes the story and the project", async () => {
    const { w } = setup({ story: { state: "design", issues } });
    const { client } = renderAt();
    await loaded();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fireEvent.click(within(section()).getByRole("button", { name: "Unlink issue acme/widgets#42" }));
    await waitFor(() => expect(within(section()).queryByRole("link", { name: "acme/widgets#42" })).toBeNull());
    expect(w.issueWrites).toEqual([{ id: 1, body: { story_id: null } }]);
    expect(within(section()).getByRole("link", { name: "acme/widgets#43" })).toBeTruthy();
    const keys = invalidate.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toEqual(expect.arrayContaining(['["story"]', '["project",1]']));
  });

  for (const state of ["finished", "cancelled"] as const) {
    it(`keeps issue links open on a ${state} story (unlike pull requests)`, async () => {
      const { w } = setup({ story: { state, issues } });
      renderAt();
      await loaded();
      fireEvent.click(within(section()).getByRole("button", { name: "Unlink issue acme/widgets#43" }));
      await waitFor(() => expect(within(section()).queryByRole("link", { name: "acme/widgets#43" })).toBeNull());
      expect(w.issueWrites).toEqual([{ id: 2, body: { story_id: null } }]);
    });
  }

  it("shows the cached GitHub status beside linked pull requests and issues when the sync is on", async () => {
    setup({
      story: {
        state: "implementation",
        pull_requests: [pullRequest({ id: 1, number: 7, remote_status: { state: "merged", title: "Add thing", checked_at: "2026-01-02T03:04:05.000Z" } })],
        issues: [issue({ id: 5, story_id: 1, number: 3 })], // never synced: unknown
      },
      githubSync: true,
    });
    renderAt();
    const prs = await screen.findByRole("region", { name: "Pull requests" });
    expect((await within(prs).findByLabelText("GitHub status: merged")).textContent).toBe("merged");
    expect((await screen.findByLabelText("GitHub status: unknown")).textContent).toBe("unknown");
  });

  it("shows no GitHub status badges when the sync is off", async () => {
    setup({ story: { pull_requests: [pullRequest({ id: 1 })] } });
    renderAt();
    await screen.findByText("acme/widgets#7");
    expect(screen.queryByLabelText(/GitHub status/)).toBeNull();
  });
});
