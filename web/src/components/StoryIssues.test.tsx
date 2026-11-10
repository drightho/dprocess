import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import StoryIssues from "./StoryIssues";
import { issue, mockApi, storyDetail } from "../test/fixtures";

const MSG = "Different repository than the project's linked repository";

function show(issues: ReturnType<typeof issue>[], state: "draft" | "finished" = "draft") {
  mockApi({ "/api/v1/github-sync": { enabled: false, last_run_at: null, last_error: "" } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StoryIssues story={storyDetail({ state, issues })} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("StoryIssues repo_mismatch badge", () => {
  it("marks only the issue whose warnings contain repo_mismatch", () => {
    show([
      issue({ id: 1, number: 42, warnings: ["repo_mismatch"] }),
      issue({ id: 2, number: 43, github_url: "https://github.com/acme/widgets/issues/43", warnings: [] }),
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
    show([issue({ id: 1, warnings: [] }), issue({ id: 2, warnings: ["estimate_exceeds_400_loc", "brand_new_code"] })]);
    expect(screen.queryByLabelText(MSG)).toBeNull();
    expect(screen.queryByText("other repo")).toBeNull();
  });

  it("still shows the badge on a finished story, where issue links stay open", () => {
    show([issue({ warnings: ["repo_mismatch"] })], "finished");
    expect(screen.getAllByLabelText(MSG)).toHaveLength(1);
  });
});
