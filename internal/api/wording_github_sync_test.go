package api

// Design tests for story 92: the texts that called the GitHub sync read-only
// say instead that its only write is assigning imported issues to the token
// owner. Wording only; the files are read by relative path.

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func readRepo(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile("../../" + rel)
	if err != nil {
		t.Fatalf("reading %s: %v", rel, err)
	}
	return string(b)
}

// lineWith returns the first line of text that has the prefix (after trimming)
// or, with contains set, that contains it.
func lineWith(t *testing.T, text, needle string, prefix bool) string {
	t.Helper()
	for _, l := range strings.Split(text, "\n") {
		if (prefix && strings.HasPrefix(strings.TrimSpace(l), needle)) || (!prefix && strings.Contains(l, needle)) {
			return l
		}
	}
	t.Fatalf("no line with %q", needle)
	return ""
}

// commentAbove joins the // comment block that ends right above the line
// containing anchor.
func commentAbove(t *testing.T, src, anchor string) string {
	t.Helper()
	lines := strings.Split(src, "\n")
	for i, l := range lines {
		if !strings.Contains(l, anchor) {
			continue
		}
		var parts []string
		for j := i - 1; j >= 0 && strings.HasPrefix(strings.TrimSpace(lines[j]), "//"); j-- {
			parts = append([]string{strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(lines[j]), "//"))}, parts...)
		}
		return strings.Join(parts, " ")
	}
	t.Fatalf("no line with %q", anchor)
	return ""
}

func TestWordingBannedPhrasesGone(t *testing.T) {
	cases := []struct {
		file    string
		phrases []string
	}{
		{"README.md", []string{"read-only sync", "GET only, never writes", "it still only reads GitHub", "GitHub is only read when the optional status sync is on"}},
		{"internal/github/github.go", []string{"strictly read-only", "it only issues GET requests", "It never writes to GitHub"}},
		{"internal/api/api.go", []string{"read-only status sync"}},
		{"api/openapi.yaml", []string{"optional read-only GitHub status sync"}},
		{"web/src/api/schema.d.ts", []string{"optional read-only GitHub status sync"}},
		{"web/src/pages/IssuesPage.tsx", []string{"it only reads GitHub"}},
	}
	for _, c := range cases {
		text := strings.ToLower(readRepo(t, c.file))
		for _, p := range c.phrases {
			if strings.Contains(text, strings.ToLower(p)) {
				t.Errorf("%s still contains %q", c.file, p)
			}
		}
	}
}

func TestWordingFlagHelpNotReadOnly(t *testing.T) {
	l := lineWith(t, readRepo(t, "cmd/dprocess/main.go"), `flag.Bool("github-sync"`, false)
	if strings.Contains(strings.ToLower(l), "read-only") {
		t.Errorf("--github-sync help still says read-only: %s", l)
	}
	if !strings.Contains(l, "DPROCESS_GITHUB_TOKEN") {
		t.Errorf("--github-sync help lost the token hint: %s", l)
	}
}

// No remaining text may call the sync as a whole read-only or non-writing.
func TestWordingNoWholeSyncReadOnlyClaim(t *testing.T) {
	re := regexp.MustCompile(`(?i)sync (is|that is|which is) (strictly |purely )?read-only|read-only (github )?(status )?sync|never writes|does not write|doesn't write|only reads github|only issues get`)
	for _, f := range []string{"README.md", "internal/github/github.go", "internal/api/api.go", "cmd/dprocess/main.go", "api/openapi.yaml", "web/src/pages/IssuesPage.tsx"} {
		for i, l := range strings.Split(readRepo(t, f), "\n") {
			if re.MatchString(l) {
				t.Errorf("%s:%d claims the sync is read-only or never writes: %s", f, i+1, strings.TrimSpace(l))
			}
		}
	}
}

var (
	wordAssignRe  = regexp.MustCompile(`(?i)\bassign\w*`)
	wordOwnerRe   = regexp.MustCompile(`(?i)token owner|owner of .{0,40}token`)
	wordOnlyRe    = regexp.MustCompile(`(?i)\bonly\b`)
	wordNoWriteRe = regexp.MustCompile(`(?i)never writes|does not write|doesn't write|no writes|read-only`)
)

func TestWordingOnlyWriteIsAssigning(t *testing.T) {
	gh := readRepo(t, "internal/github/github.go")
	pkgEnd := strings.Index(gh, "\npackage github")
	if pkgEnd < 0 {
		t.Fatal("package clause not found")
	}
	pkgComment := strings.Join(strings.Fields(strings.ReplaceAll(gh[:pkgEnd], "//", " ")), " ")
	readme := readRepo(t, "README.md")
	texts := map[string]string{
		"README status-sync paragraph": lineWith(t, readme, "**GitHub status sync", true),
		"package comment":              pkgComment,
		"RunOnce comment":              commentAbove(t, gh, "func (y *Syncer) RunOnce"),
		"Issues page text":             lineWith(t, readRepo(t, "web/src/pages/IssuesPage.tsx"), `className="meta">References to GitHub issues`, false),
	}
	for name, s := range texts {
		if !wordAssignRe.MatchString(s) {
			t.Errorf("%s does not mention assigning", name)
		}
		if !wordOwnerRe.MatchString(s) {
			t.Errorf("%s does not mention the token owner", name)
		}
		if !wordOnlyRe.MatchString(s) {
			t.Errorf("%s has no \"only\" wording for the single write", name)
		}
		if m := wordNoWriteRe.FindString(s); m != "" {
			t.Errorf("%s says %q", name, m)
		}
	}
}

func TestWordingRunOnceKeepsNeverFailsServer(t *testing.T) {
	c := commentAbove(t, readRepo(t, "internal/github/github.go"), "func (y *Syncer) RunOnce")
	if !strings.Contains(c, "never fails the server") {
		t.Errorf("RunOnce comment lost \"never fails the server\": %s", c)
	}
}

func TestWordingUntouchedTexts(t *testing.T) {
	const put = "summary: Turn the GitHub status sync on or off while the server is running"
	if !strings.Contains(readRepo(t, "api/openapi.yaml"), put) {
		t.Errorf("openapi.yaml lost the PUT summary")
	}
	if !strings.Contains(readRepo(t, "web/src/api/schema.d.ts"), "* Turn the GitHub status sync on or off while the server is running") {
		t.Errorf("schema.d.ts lost the PUT summary")
	}
	if !strings.Contains(readRepo(t, "internal/store/migrations/0004_github_status.sql"), "-- Cached read-only status of GitHub issues and pull requests") {
		t.Errorf("migration 0004 comment changed")
	}
}

func TestWordingGetSummaryMatchesSchemaTypes(t *testing.T) {
	spec := strings.Split(readRepo(t, "api/openapi.yaml"), "\n")
	var summary string
	for i, l := range spec {
		if strings.TrimSpace(l) == "operationId: getGitHubSync" {
			for _, m := range spec[i+1:] {
				if v, ok := strings.CutPrefix(strings.TrimSpace(m), "summary:"); ok {
					summary = strings.Trim(strings.TrimSpace(v), `"`)
					break
				}
			}
			break
		}
	}
	if summary == "" {
		t.Fatal("GET summary not found in openapi.yaml")
	}
	if strings.Contains(strings.ToLower(summary), "read-only") {
		t.Errorf("openapi.yaml GET summary still says read-only: %s", summary)
	}
	types := readRepo(t, "web/src/api/schema.d.ts")
	if !strings.Contains(types, "* "+summary+"\n") {
		t.Errorf("schema.d.ts does not carry the GET summary %q", summary)
	}
	if strings.Contains(strings.ToLower(types), "optional read-only github status sync") {
		t.Errorf("schema.d.ts still has the old GET summary")
	}
}
