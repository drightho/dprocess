import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import GitHubSyncPanel from "./GitHubSyncPanel";
import RemoteStatusBadge from "./RemoteStatusBadge";
import { mockApi, problem } from "../test/fixtures";

const URL_SYNC = "/api/v1/github-sync";
const RUN = "2026-01-02T03:04:05Z";
const RUN_TEXT = "2026-01-02 03:04 UTC";

type Sync = { enabled: boolean; last_run_at: string | null; last_error: string };
const off: Sync = { enabled: false, last_run_at: null, last_error: "" };
const on = (over: Partial<Sync> = {}): Sync => ({ enabled: true, last_run_at: RUN, last_error: "", ...over });

function renderPanel(extra?: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GitHubSyncPanel />
      {extra}
    </QueryClientProvider>,
  );
}

const region = () => screen.getByRole("region", { name: "GitHub status sync" });
const theSwitch = () => screen.getByRole("switch", { name: "GitHub status sync" });
const findSwitch = () => screen.findByRole("switch", { name: "GitHub status sync" });
const isOn = (el: HTMLElement) =>
  el instanceof HTMLInputElement ? el.checked : el.getAttribute("aria-checked") === "true";
const isDisabled = (el: HTMLElement) => (el as HTMLInputElement | HTMLButtonElement).disabled === true;
const alertTexts = () => screen.queryAllByRole("alert").map((a) => a.textContent ?? "");

/** A GET/PUT stand-in: GET answers the current state; PUT answers with `put(req)` and records bodies. */
function syncServer(initial: Sync | Response, put?: (req: Request) => unknown | Promise<unknown>) {
  const state = { current: initial, gets: 0, puts: [] as unknown[] };
  const api = mockApi({
    [URL_SYNC]: async (req: Request) => {
      if (req.method === "PUT") {
        state.puts.push(await req.clone().json());
        const out = put ? await put(req) : undefined;
        if (out instanceof Response) return out;
        if (out !== undefined) state.current = out as Sync;
        return state.current;
      }
      state.gets++;
      return state.current;
    },
  });
  return { ...api, state };
}

describe("GitHubSyncPanel: showing the server's state", () => {
  it("shows the switch off when the server says the sync is off", async () => {
    syncServer(off);
    renderPanel();
    expect(isOn(await findSwitch())).toBe(false);
  });

  it("shows the switch on when the server says the sync is on", async () => {
    syncServer(on());
    renderPanel();
    expect(isOn(await findSwitch())).toBe(true);
  });

  it("shows no switch while the state is still loading", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockApi({ [URL_SYNC]: async () => (await gate, off) });
    renderPanel();
    expect(screen.queryByRole("switch")).toBeNull();
    release();
    await findSwitch();
  });

  it("shows the last run time when there is one", async () => {
    syncServer(on());
    renderPanel();
    await findSwitch();
    expect(region().textContent).toContain(RUN_TEXT);
  });

  it("shows no run time while the server reports none (just enabled)", async () => {
    syncServer(on({ last_run_at: null }));
    renderPanel();
    await findSwitch();
    expect(region().textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("shows last_error in an alert", async () => {
    syncServer(on({ last_error: "GitHub answered 401 bad credentials" }));
    renderPanel();
    await findSwitch();
    expect(alertTexts().some((t) => t.includes("GitHub answered 401 bad credentials"))).toBe(true);
  });

  it("shows no alert when last_error is empty", async () => {
    syncServer(on());
    renderPanel();
    await findSwitch();
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("shows neither a run time nor an error while the sync is off", async () => {
    syncServer({ enabled: false, last_run_at: RUN, last_error: "stale problem" });
    renderPanel();
    await findSwitch();
    expect(region().textContent).not.toContain(RUN_TEXT);
    expect(region().textContent).not.toContain("stale problem");
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("has no token field and no token hint", async () => {
    syncServer(on({ last_error: "no token configured" }));
    renderPanel();
    await findSwitch();
    const r = within(region());
    expect(r.queryByLabelText(/token/i)).toBeNull();
    expect(r.queryAllByRole("textbox")).toHaveLength(0);
    // The only "token" text allowed is the server's own last_error.
    const hints = region().textContent!.replace("no token configured", "");
    expect(hints).not.toMatch(/token/i);
  });
});

describe("GitHubSyncPanel: toggling", () => {
  it("enables the sync with a PUT of {enabled: true} and shows what the server returned", async () => {
    const s = syncServer(off, () => on());
    renderPanel();
    fireEvent.click(await findSwitch());
    await waitFor(() => expect(isOn(theSwitch())).toBe(true));
    expect(s.state.puts).toEqual([{ enabled: true }]);
    expect(region().textContent).toContain(RUN_TEXT);
  });

  it("disables the sync with a PUT of {enabled: false} and then shows no run time or error", async () => {
    const s = syncServer(on({ last_error: "boom" }), () => off);
    renderPanel();
    fireEvent.click(await findSwitch());
    await waitFor(() => expect(isOn(theSwitch())).toBe(false));
    expect(s.state.puts).toEqual([{ enabled: false }]);
    expect(region().textContent).not.toContain(RUN_TEXT);
    expect(alertTexts().some((t) => t.includes("boom"))).toBe(false);
  });

  it("shows the state the server returned, not the one that was asked for", async () => {
    // The server answers "still off" to an enable request: no optimistic change.
    syncServer(off, () => off);
    renderPanel();
    fireEvent.click(await findSwitch());
    await waitFor(() => expect(isDisabled(theSwitch())).toBe(false));
    expect(isOn(theSwitch())).toBe(false);
  });

  it("does not change the switch before the server has answered, and disables it meanwhile", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    syncServer(off, async () => {
      await gate;
      return on();
    });
    renderPanel();
    fireEvent.click(await findSwitch());

    await waitFor(() => expect(isDisabled(theSwitch())).toBe(true));
    expect(isOn(theSwitch())).toBe(false);

    release();
    await waitFor(() => expect(isDisabled(theSwitch())).toBe(false));
    expect(isOn(theSwitch())).toBe(true);
  });

  it("refreshes the github-sync query after a successful toggle", async () => {
    const s = syncServer(off, () => on());
    renderPanel();
    fireEvent.click(await findSwitch());
    await waitFor(() => expect(s.state.gets).toBeGreaterThanOrEqual(2));
  });

  it("makes RemoteStatusBadge appear without a reload after enabling", async () => {
    syncServer(off, () => on());
    renderPanel(<RemoteStatusBadge status={{ state: "open", title: "T", checked_at: RUN }} />);
    fireEvent.click(await findSwitch());
    expect(await screen.findByLabelText("GitHub status: open")).toBeTruthy();
  });

  it("makes RemoteStatusBadge disappear without a reload after disabling", async () => {
    syncServer(on(), () => off);
    renderPanel(<RemoteStatusBadge status={{ state: "open", title: "T", checked_at: RUN }} />);
    await screen.findByLabelText("GitHub status: open");
    fireEvent.click(theSwitch());
    await waitFor(() => expect(screen.queryByLabelText("GitHub status: open")).toBeNull());
  });
});

describe("GitHubSyncPanel: failures", () => {
  const failing = (initial: Sync) =>
    syncServer(initial, () => problem(500, "internal error", "cannot start the syncer"));

  it("keeps the old state and shows the server's detail when the PUT fails", async () => {
    failing(off);
    renderPanel();
    fireEvent.click(await findSwitch());
    await waitFor(() => expect(alertTexts().some((t) => t.includes("cannot start the syncer"))).toBe(true));
    expect(isOn(theSwitch())).toBe(false);
    expect(isDisabled(theSwitch())).toBe(false);
  });

  it("keeps the old state when a disable fails", async () => {
    failing(on());
    renderPanel();
    fireEvent.click(await findSwitch());
    await waitFor(() => expect(alertTexts().some((t) => t.includes("cannot start the syncer"))).toBe(true));
    expect(isOn(theSwitch())).toBe(true);
  });

  it("keeps showing the last known run time and last_error next to the PUT failure", async () => {
    failing(on({ last_error: "earlier trouble" }));
    renderPanel();
    fireEvent.click(await findSwitch());
    await waitFor(() => expect(alertTexts().some((t) => t.includes("cannot start the syncer"))).toBe(true));
    expect(region().textContent).toContain(RUN_TEXT);
    const texts = alertTexts();
    expect(texts.some((t) => t.includes("earlier trouble"))).toBe(true);
    // Two separate alerts: the PUT failure is not merged into last_error.
    expect(texts.find((t) => t.includes("cannot start the syncer"))).not.toContain("earlier trouble");
  });

  it("clears the failure message on the next attempt", async () => {
    let fail = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    syncServer(off, async () => {
      if (fail) return problem(500, "internal error", "cannot start the syncer");
      await gate;
      return on();
    });
    renderPanel();
    fireEvent.click(await findSwitch());
    await waitFor(() => expect(alertTexts().some((t) => t.includes("cannot start the syncer"))).toBe(true));

    fail = false;
    fireEvent.click(theSwitch());
    // Gone as soon as the new attempt starts, while that attempt is still in flight.
    await waitFor(() => expect(alertTexts().some((t) => t.includes("cannot start the syncer"))).toBe(false));
    expect(isDisabled(theSwitch())).toBe(true);
    release();
    await waitFor(() => expect(isOn(theSwitch())).toBe(true));
  });

  it("says the state could not be loaded and shows no switch when the first GET fails", async () => {
    mockApi({ [URL_SYNC]: problem(500, "internal error", "database is on fire") });
    renderPanel();
    await waitFor(() => expect(alertTexts().some((t) => /could not load/i.test(t))).toBe(true));
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("does not show the sync as off when the first GET fails (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    renderPanel();
    await waitFor(() => expect(alertTexts().some((t) => /could not load/i.test(t))).toBe(true));
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
