import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import EpicForm from "./EpicForm";
import { epic, json, mockApi, problem } from "../test/fixtures";

type Body = Record<string, unknown>;

function renderForm(props: Partial<React.ComponentProps<typeof EpicForm>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <EpicForm projectId={3} onDone={onDone} onCancel={onCancel} {...props} />
    </QueryClientProvider>,
  );
  return { onDone, onCancel, invalidate };
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => fireEvent.submit(screen.getByRole("form"));

function server(answer: (body: Body) => Response | unknown) {
  const writes: { method: string; path: string; body: Body }[] = [];
  const handle = (path: string) => async (req: Request) => {
    if (req.method === "GET") return [];
    writes.push({ method: req.method, path, body: (await req.json()) as Body });
    return answer(writes[writes.length - 1].body);
  };
  mockApi({ "/api/v1/projects/3/epics": handle("/projects/3/epics"), "/api/v1/epics/5": handle("/epics/5") });
  return writes;
}

describe("EpicForm", () => {
  it("creates an epic in the project and refreshes the project", async () => {
    const saved = epic({ id: 9, project_id: 3, name: "Billing" });
    const writes = server(() => json(saved, 201));
    const { onDone, invalidate } = renderForm();
    expect(screen.getByRole("form", { name: "New epic" })).toBeTruthy();

    type("Name", "Billing");
    type("Description", "Invoices");
    submit();

    await waitFor(() => expect(onDone).toHaveBeenCalledWith(saved));
    expect(writes).toEqual([{ method: "POST", path: "/projects/3/epics", body: { name: "Billing", description: "Invoices" } }]);
    const keys = invalidate.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toContain('["project",3]');
    expect(keys).toContain('["epic",9]');
  });

  it("edits an epic starting from its current values", async () => {
    const existing = epic({ id: 5, project_id: 3, name: "Auth", description: "Sign-in" });
    const saved = { ...existing, name: "Authentication" };
    const writes = server(() => json(saved));
    const { onDone } = renderForm({ projectId: undefined, epic: existing });
    expect(screen.getByRole("form", { name: "Edit epic" })).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Auth");
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Sign-in");

    type("Name", "Authentication");
    submit();
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(saved));
    expect(writes).toEqual([{ method: "PATCH", path: "/epics/5", body: { name: "Authentication", description: "Sign-in" } }]);
  });

  it("shows the server's validation message inside the form and keeps the input", async () => {
    server(() => problem(422, "validation failed", "name is required"));
    const { onDone } = renderForm();
    type("Description", "kept");
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("name is required");
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("kept");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("cancels without sending anything", () => {
    const writes = server(() => json(epic(), 201));
    const { onCancel } = renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
});

describe("EpicForm stale errors", () => {
  it("dismisses the server's message as soon as a field is edited", async () => {
    server(() => problem(422, "validation failed", "name is required"));
    renderForm();
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("name is required");
    type("Name", "Billing");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
