import { repoLabel, repoWarningMessage } from "./github";

describe("repoWarningMessage", () => {
  it("maps repo_mismatch to the badge message", () => {
    expect(repoWarningMessage("repo_mismatch")).toBe("Different repository than the project's linked repository");
  });

  it.each(["estimate_exceeds_400_loc", "something_new", "", "REPO_MISMATCH"])("shows nothing for %j", (code) => {
    expect(repoWarningMessage(code)).toBeNull();
  });
});

describe("repoLabel", () => {
  it("is owner/repo from the saved URL", () => {
    expect(repoLabel("https://github.com/acme/widgets")).toBe("acme/widgets");
  });

  it("ignores a trailing slash", () => {
    expect(repoLabel("https://github.com/acme/widgets/")).toBe("acme/widgets");
  });

  it("falls back to the whole string when it does not look like a repo URL", () => {
    expect(repoLabel("not a url")).toBe("not a url");
    expect(repoLabel("https://example.com/acme/widgets")).toBe("https://example.com/acme/widgets");
  });
});
