package service

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

const repoMsg = "expected https://github.com/{owner}/{repo}"

func TestParseRepoURLAccepts(t *testing.T) {
	for _, in := range []string{
		"https://github.com/owner/repo",
		"https://github.com/Owner/Repo",
		"https://github.com/owner/repo/",
		"https://github.com/owner/repo.git",
		"https://github.com/Owner/Repo.GIT",
		"https://github.com/owner/repo.git/",
		"  https://github.com/owner/repo  ",
		"\thttps://github.com/Owner/Repo.git/\n",
		"https://GitHub.com/Owner/Repo",
		"HTTPS://GITHUB.COM/owner/repo.git",
	} {
		repo, canonical, err := ParseRepoURL(in)
		if err != nil || repo != "owner/repo" || canonical != "https://github.com/owner/repo" {
			t.Errorf("%q: got %q %q %v", in, repo, canonical, err)
		}
	}
	// Names with dots, dashes and underscores; ".git" is stripped once and only when something remains.
	for in, want := range map[string]string{
		"https://github.com/my-org/my_repo.js": "my-org/my_repo.js",
		"https://github.com/o/x.git.git":       "o/x.git",
		"https://github.com/o/.github":         "o/.github",
		"https://github.com/o/a..b":            "o/a..b",
		"https://github.com/O.rg/R.GIT":        "o.rg/r",
	} {
		repo, canonical, err := ParseRepoURL(in)
		if err != nil || repo != want || canonical != "https://github.com/"+want {
			t.Errorf("%q: got %q %q %v, want %q", in, repo, canonical, err, want)
		}
	}
}

func TestParseRepoURLRefuses(t *testing.T) {
	for _, in := range []string{
		"",
		"   ",
		"owner/repo",
		"github.com/owner/repo",
		"http://github.com/owner/repo",
		"https://www.github.com/owner/repo",
		"https://gitlab.com/owner/repo",
		"https://github.com.evil.com/owner/repo",
		"https://user@github.com/owner/repo",
		"https://user:pw@github.com/owner/repo",
		"https://github.com/owner/repo?tab=readme",
		"https://github.com/owner/repo?",
		"https://github.com/owner/repo#readme",
		"https://github.com/owner/repo/tree/main",
		"https://github.com/owner/repo/issues",
		"https://github.com/owner/repo/issues/1",
		"https://github.com/owner/repo/pull/1",
		"https://github.com/owner/repo//",
		"https://github.com/",
		"https://github.com",
		"https://github.com/owner",
		"https://github.com/owner/",
		"https://github.com//repo",
		"https://github.com/./repo",
		"https://github.com/owner/.",
		"https://github.com/../repo",
		"https://github.com/owner/..",
		"https://github.com/.../repo",
		"https://github.com/owner/.git",
		"https://github.com/owner/..git",
		"https://github.com/ow ner/repo",
		"https://github.com/owner/re%20po",
		"https://github.com/owner/re$po",
		"https://github.com/owner/repo\x00",
	} {
		repo, canonical, err := ParseRepoURL(in)
		if err == nil {
			t.Errorf("%q: accepted as %q %q", in, repo, canonical)
			continue
		}
		if !errors.Is(err, ErrInvalidRepoURL) || !strings.Contains(err.Error(), repoMsg) {
			t.Errorf("%q: wrong error %v", in, err)
		}
		if repo != "" || canonical != "" {
			t.Errorf("%q: results must be empty on error, got %q %q", in, repo, canonical)
		}
	}
}

// ParseIssueURL and ParsePullRequestURL keep their behaviour.
func TestIssueAndPullURLsUnchanged(t *testing.T) {
	repo, n, c, err := ParseIssueURL(" https://github.com/Acme/Widgets/issues/7/ ")
	if err != nil || repo != "acme/widgets" || n != 7 || c != "https://github.com/acme/widgets/issues/7" {
		t.Errorf("issue: %q %d %q %v", repo, n, c, err)
	}
	repo, n, c, err = ParsePullRequestURL("https://github.com/Acme/Widgets/pull/8")
	if err != nil || repo != "acme/widgets" || n != 8 || c != "https://github.com/acme/widgets/pull/8" {
		t.Errorf("pull: %q %d %q %v", repo, n, c, err)
	}
	if _, _, _, err := ParseIssueURL("https://github.com/acme/widgets/issues/7.git"); !errors.Is(err, ErrInvalidIssueURL) {
		t.Errorf("issue url with .git: %v", err)
	}
	if _, _, _, err := ParseIssueURL("https://github.com/acme/widgets"); !errors.Is(err, ErrInvalidIssueURL) {
		t.Errorf("repo url as issue: %v", err)
	}
	if _, _, _, err := ParsePullRequestURL("https://github.com/acme/widgets/issues/8"); !errors.Is(err, ErrInvalidPullRequestURL) {
		t.Errorf("issue url as pull: %v", err)
	}
}

func TestRepoMismatchWarning(t *testing.T) {
	mismatch := []string{"repo_mismatch"}
	for _, tc := range []struct {
		name, project, item string
		want                []string
	}{
		{"no link", "", "acme/widgets", []string{}},
		{"no link, empty item", "", "", []string{}},
		{"same repo", "https://github.com/acme/widgets", "acme/widgets", []string{}},
		{"other repo", "https://github.com/acme/widgets", "acme/other", mismatch},
		{"other owner", "https://github.com/acme/widgets", "evil/widgets", mismatch},
		{"prefix is not a match", "https://github.com/acme/widgets", "acme/widgets2", mismatch},
		{"prefix the other way", "https://github.com/acme/widgets2", "acme/widgets", mismatch},
		{"compared lower-case", "https://github.com/Acme/Widgets", "acme/widgets", []string{}},
		{"item upper-case", "https://github.com/acme/widgets", "ACME/Widgets", []string{}},
	} {
		got := RepoMismatchWarning(tc.project, tc.item)
		if got == nil || !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: got %#v, want %#v", tc.name, got, tc.want)
		}
	}
}
