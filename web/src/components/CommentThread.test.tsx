import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CommentThread from "./CommentThread";
import { AUTHOR_KEY } from "../lib/author";
import { comment, json, mockApi, problem, type Comment } from "../test/fixtures";

function renderThread(kind: "epic" | "story" = "story") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CommentThread kind={kind} id={1} />
    </QueryClientProvider>,
  );
}

/** A stateful fake of the comment endpoints. */
function server(kind: "epic" | "story", initial: Comment[], refuse?: (body: { body: string; author?: string }) => Response | undefined) {
  const state = { comments: [...initial], posts: [] as { body: string; author?: string }[] };
  const path = kind === "epic" ? "/api/v1/epics/1/comments" : "/api/v1/stories/1/comments";
  mockApi({
    [path]: async (req: Request) => {
      if (req.method === "GET") return state.comments;
      const body = (await req.json()) as { body: string; author?: string };
      state.posts.push(body);
      const refused = refuse?.(body);
      if (refused) return refused;
      const created = comment({ id: state.comments.length + 1, entity_type: kind, body: body.body.trim(), author: (body.author ?? "").trim(), created_at: "2026-02-03T04:05:06.000Z" });
      state.comments = [...state.comments, created];
      return json(created, 201);
    },
  });
  return state;
}

const items = () => within(screen.getByRole("list", { name: "Comment thread" })).getAllByRole("listitem").map((li) => li.textContent ?? "");
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const post = () => fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

describe("CommentThread", () => {
  it("lists the comments oldest first, with author and time", async () => {
    server("story", [
      comment({ id: 1, author: "ann", body: "First", created_at: "2026-01-02T03:04:05.000Z" }),
      comment({ id: 2, author: "", body: "Second\nwith two lines", created_at: "2026-01-03T10:00:00.000Z" }),
    ]);
    renderThread();
    await screen.findByRole("list", { name: "Comment thread" });
    const [first, second] = items();
    expect(first).toContain("ann");
    expect(first).toContain("2026-01-02 03:04 UTC");
    expect(first).toContain("First");
    expect(second).toContain("anonymous");
    expect(second).toContain("Second\nwith two lines");
  });

  it("says when there are no comments", async () => {
    server("story", []);
    renderThread();
    expect(await screen.findByText("No comments yet.")).toBeTruthy();
  });

  it("posts a comment with its author and shows it", async () => {
    const state = server("story", [comment({ id: 1, author: "ann", body: "First" })]);
    renderThread();
    await screen.findByRole("list", { name: "Comment thread" });

    type("Author", "bob");
    type("Comment", "  Looks good  ");
    post();

    await waitFor(() => expect(items()).toHaveLength(2));
    expect(state.posts).toEqual([{ body: "  Looks good  ", author: "bob" }]);
    expect(items()[1]).toContain("bob");
    expect(items()[1]).toContain("Looks good");
    expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe(""); // cleared
    expect((screen.getByLabelText("Author") as HTMLInputElement).value).toBe("bob"); // kept for the next one
  });

  it("remembers the author in the browser and prefills it next time", async () => {
    server("story", []);
    renderThread();
    await screen.findByText("No comments yet.");
    type("Author", "carol");
    type("Comment", "Hello");
    post();
    await waitFor(() => expect(window.localStorage.getItem(AUTHOR_KEY)).toBe("carol"));

    // A new thread (another page, another visit) starts with the remembered name.
    server("epic", []);
    renderThread("epic");
    await waitFor(() => expect((screen.getAllByLabelText("Author")[1] as HTMLInputElement).value).toBe("carol"));
  });

  it("works the same for epics", async () => {
    const state = server("epic", []);
    renderThread("epic");
    await screen.findByText("No comments yet.");
    type("Comment", "On the epic");
    post();
    await waitFor(() => expect(items()).toHaveLength(1));
    expect(state.posts).toEqual([{ body: "On the epic", author: "" }]);
    expect(items()[0]).toContain("anonymous");
  });

  it("shows the server's message inside the form, keeps the text, and dismisses it when typing", async () => {
    server("story", [], () => problem(422, "validation failed", "body is required"));
    renderThread();
    await screen.findByText("No comments yet.");
    type("Author", "ann");
    post();
    expect((await screen.findByRole("alert")).textContent).toContain("body is required");
    expect((screen.getByLabelText("Author") as HTMLInputElement).value).toBe("ann");
    type("Comment", "Now with text");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not forget the comment when posting fails", async () => {
    server("story", [], () => problem(500, "internal error", "database is on fire"));
    renderThread();
    await screen.findByText("No comments yet.");
    type("Comment", "Important thought");
    post();
    expect((await screen.findByRole("alert")).textContent).toContain("database is on fire");
    expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("Important thought");
  });

  it("reports a failure to load the comments", async () => {
    mockApi({ "/api/v1/stories/1/comments": problem(500, "internal error", "comments are broken") });
    renderThread();
    expect((await screen.findByRole("alert")).textContent).toContain("comments are broken");
  });

  it("sends one comment even if the button is pressed twice", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const posts: unknown[] = [];
    mockApi({
      "/api/v1/stories/1/comments": async (req: Request) => {
        if (req.method === "GET") return [];
        posts.push(await req.json());
        await gate;
        return json(comment({ id: 1 }), 201);
      },
    });
    renderThread();
    await screen.findByText("No comments yet.");
    type("Comment", "Once");
    post();
    await waitFor(() => expect((screen.getByRole("button", { name: "Add comment" }) as HTMLButtonElement).disabled).toBe(true));
    post();
    release();
    await waitFor(() => expect(posts).toHaveLength(1));
  });
});
