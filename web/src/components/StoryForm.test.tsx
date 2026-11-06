import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import StoryForm from "./StoryForm";
import { json, mockApi, problem, story } from "../test/fixtures";

type Body = Record<string, unknown>;

function renderForm(props: Partial<React.ComponentProps<typeof StoryForm>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <StoryForm epicId={1} onDone={onDone} onCancel={onCancel} {...props} />
    </QueryClientProvider>,
  );
  return { onDone, onCancel, invalidate };
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => fireEvent.submit(screen.getByRole("form"));

/** Records the JSON body of every write and answers with the given story or response. */
function server(answer: (body: Body) => Response | unknown) {
  const bodies: { method: string; path: string; body: Body }[] = [];
  const handle = (path: string) => async (req: Request) => {
    if (req.method === "GET") return [];
    const body = (await req.json()) as Body;
    bodies.push({ method: req.method, path, body });
    return answer(body);
  };
  const m = mockApi({ "/api/v1/epics/1/stories": handle("/epics/1/stories"), "/api/v1/stories/7": handle("/stories/7") });
  return { bodies, ...m };
}

describe("StoryForm creating", () => {
  it("sends every field and reports the saved story", async () => {
    const saved = story({ id: 11, epic_id: 1, project_id: 3, name: "Login form" });
    const { bodies } = server(() => json(saved, 201));
    const { onDone, invalidate } = renderForm();

    type("Name", "Login form");
    type("Description", "A form");
    type("Acceptance criteria", "It logs in");
    type("Assignee", "bob");
    type("Estimate (lines of code)", "120");
    submit();

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(saved));
    expect(bodies).toEqual([
      { method: "POST", path: "/epics/1/stories", body: { name: "Login form", description: "A form", acceptance_criteria: "It logs in", assignee: "bob", estimate_loc: 120 } },
    ]);
    // The epic's data and the project's board are refreshed.
    const keys = invalidate.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toContain('["epic",1]');
    expect(keys).toContain('["project",3]');
  });

  it("sends no estimate when the field is empty", async () => {
    const { bodies } = server(() => json(story({ id: 1 }), 201));
    const { onDone } = renderForm();
    type("Name", "No size yet");
    submit();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(bodies[0].body.estimate_loc).toBeNull();
  });

  it("shows the server's validation message inside the form and keeps what was typed", async () => {
    server(() => problem(422, "validation failed", "name is required"));
    const { onDone } = renderForm();
    type("Assignee", "bob");
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("name is required");
    expect((screen.getByLabelText("Assignee") as HTMLInputElement).value).toBe("bob");
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("form")).toBeTruthy();
  });

  it("shows the server's message when the epic no longer accepts stories", async () => {
    server(() => problem(409, "conflict", "epic 1 is finished: epic is finished or cancelled"));
    renderForm();
    type("Name", "Late");
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("epic is finished or cancelled");
  });

  it("explains a decimal estimate without calling the server", async () => {
    const { bodies } = server(() => json(story(), 201));
    renderForm();
    type("Name", "x");
    type("Estimate (lines of code)", "12.5");
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("whole number");
    expect(bodies).toHaveLength(0);
    // Editing the field clears the message.
    type("Estimate (lines of code)", "12");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("passes a negative estimate on so the server can explain", async () => {
    server((b) => (b.estimate_loc === -5 ? problem(422, "validation failed", "estimate_loc must not be negative") : json(story(), 201)));
    renderForm();
    type("Name", "x");
    type("Estimate (lines of code)", "-5");
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("must not be negative");
  });

  it("calls onCancel without sending anything", () => {
    const { bodies } = server(() => json(story(), 201));
    const { onCancel } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    expect(bodies).toHaveLength(0);
  });

  it("disables the buttons while saving and sends once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { bodies } = server(() => json(story({ id: 2 }), 201));
    // Hold the answer back to observe the in-flight state.
    mockApi({ "/api/v1/epics/1/stories": async (req: Request) => { if (req.method !== "GET") { bodies.push({ method: "POST", path: "", body: await req.json() }); await gate; return json(story({ id: 2 }), 201); } return []; } });
    const { onDone } = renderForm();
    type("Name", "Slow");
    submit();
    await waitFor(() => expect((screen.getByRole("button", { name: "Create story" }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(bodies).toHaveLength(1);
  });
});

describe("StoryForm live size warning", () => {
  const warning = () => screen.queryByText(/Estimate is over 400 lines/);

  it("appears above 400 lines and not at or below it", () => {
    renderForm();
    for (const [value, shown] of [["399", false], ["400", false], ["401", true], ["450", true], ["", false], ["120", false]] as const) {
      type("Estimate (lines of code)", value);
      expect(!!warning(), `estimate "${value}"`).toBe(shown);
    }
  });

  it("is shown when editing a story that is already over the limit", () => {
    renderForm({ epicId: undefined, story: story({ id: 7, estimate_loc: 450 }) });
    expect(warning()).toBeTruthy();
  });

  it("never blocks saving", async () => {
    const { bodies } = server(() => json(story({ id: 3, estimate_loc: 450, warnings: ["estimate_exceeds_400_loc"] }), 201));
    const { onDone } = renderForm();
    type("Name", "Big one");
    type("Estimate (lines of code)", "450");
    submit();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(bodies[0].body.estimate_loc).toBe(450);
  });
});

describe("StoryForm editing", () => {
  const existing = story({ id: 7, epic_id: 1, project_id: 3, name: "Old name", description: "d", acceptance_criteria: "ac", assignee: "ann", estimate_loc: 120 });

  it("starts from the story's values", () => {
    renderForm({ epicId: undefined, story: existing });
    expect(screen.getByRole("form", { name: "Edit story" })).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Old name");
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("d");
    expect((screen.getByLabelText("Acceptance criteria") as HTMLTextAreaElement).value).toBe("ac");
    expect((screen.getByLabelText("Assignee") as HTMLInputElement).value).toBe("ann");
    expect((screen.getByLabelText("Estimate (lines of code)") as HTMLInputElement).value).toBe("120");
  });

  it("patches the story and can clear the estimate", async () => {
    const saved = { ...existing, name: "New name", estimate_loc: null };
    const { bodies } = server(() => json(saved));
    const { onDone } = renderForm({ epicId: undefined, story: existing });
    type("Name", "New name");
    type("Estimate (lines of code)", "");
    submit();
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(saved));
    expect(bodies).toEqual([
      { method: "PATCH", path: "/stories/7", body: { name: "New name", description: "d", acceptance_criteria: "ac", assignee: "ann", estimate_loc: null } },
    ]);
  });

  it("shows the server's refusal when the story was frozen meanwhile", async () => {
    server(() => problem(409, "conflict", "story 7 is finished: story is finished or cancelled and cannot be modified"));
    const { onDone } = renderForm({ epicId: undefined, story: existing });
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("cannot be modified");
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("StoryForm stale errors", () => {
  it("dismisses the server's message as soon as a field is edited", async () => {
    server(() => problem(422, "validation failed", "name must not be empty"));
    renderForm();
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("name must not be empty");
    type("Name", "Now it has a name");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
