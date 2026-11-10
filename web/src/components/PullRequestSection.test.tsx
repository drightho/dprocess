import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PullRequestSection from "./PullRequestSection";
import { mockApi, pullRequest, storyDetail } from "../test/fixtures";

const MSG = "Different repository than the project's linked repository";

function show(prs: ReturnType<typeof pullRequest>[]) {
  mockApi({ "/api/v1/github-sync": { enabled: false, last_run_at: null, last_error: "" } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PullRequestSection story={storyDetail({ pull_requests: prs })} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("PullRequestSection repo_mismatch badge", () => {
  it("marks only the pull request whose warnings contain repo_mismatch", () => {
    show([
      pullRequest({ id: 1, number: 7, warnings: ["repo_mismatch"] }),
      pullRequest({ id: 2, number: 8, github_url: "https://github.com/acme/widgets/pull/8", warnings: [] }),
    ]);
    const badge = screen.getByLabelText(MSG);
    expect(badge.textContent).toBe("other repo");
    expect(badge.getAttribute("title")).toBe(MSG);
    expect(screen.getAllByLabelText(MSG)).toHaveLength(1);
    const [first, second] = screen.getAllByRole("listitem");
    expect(first.contains(badge)).toBe(true);
    expect(second.textContent).not.toContain("other repo");
  });

  it("shows no badge for empty or unknown warning codes", () => {
    show([pullRequest({ id: 1, warnings: [] }), pullRequest({ id: 2, warnings: ["estimate_exceeds_400_loc", "brand_new_code"] })]);
    expect(screen.queryByLabelText(MSG)).toBeNull();
    expect(screen.queryByText("other repo")).toBeNull();
  });

  it("shows the badge when repo_mismatch is among several codes", () => {
    show([pullRequest({ warnings: ["brand_new_code", "repo_mismatch"] })]);
    expect(screen.getAllByLabelText(MSG)).toHaveLength(1);
  });

  it("shows the badge on a frozen (finished) story too", () => {
    mockApi({});
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <PullRequestSection story={storyDetail({ state: "finished", pull_requests: [pullRequest({ warnings: ["repo_mismatch"] })] })} />
      </QueryClientProvider>,
    );
    expect(screen.getAllByLabelText(MSG)).toHaveLength(1);
  });
});
