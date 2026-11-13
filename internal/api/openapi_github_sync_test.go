package api

// Design tests for story 90: the github-sync entries of api/openapi.yaml
// describe the issue import. The repository has no YAML library, so a small
// line scanner reads the embedded document.

import (
	"os"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	apispec "github.com/dright/dprocess/api"
)

func specLines() []string { return strings.Split(string(apispec.OpenAPI), "\n") }

func indentOf(s string) int { return len(s) - len(strings.TrimLeft(s, " ")) }

// block returns the lines under the key line at the given indent (exclusive of
// the key line), up to the next line at that indent or less.
func block(lines []string, indent int, key string) []string {
	for i, l := range lines {
		if indentOf(l) == indent && strings.TrimRight(l, " ") == strings.Repeat(" ", indent)+key {
			var out []string
			for _, m := range lines[i+1:] {
				if strings.TrimSpace(m) != "" && indentOf(m) <= indent {
					break
				}
				out = append(out, m)
			}
			return out
		}
	}
	return nil
}

// scalar reads field (at indent) from lines: plain, double-quoted or block
// scalar (>, |, with - or + chomping).
func scalar(lines []string, indent int, field string) (string, bool) {
	prefix := strings.Repeat(" ", indent) + field + ":"
	for i, l := range lines {
		if indentOf(l) != indent || !strings.HasPrefix(l, prefix) {
			continue
		}
		v := strings.TrimSpace(strings.TrimPrefix(l, prefix))
		switch {
		case v == "" || regexp.MustCompile(`^[>|][-+]?$`).MatchString(v):
			var parts []string
			for _, m := range lines[i+1:] {
				if strings.TrimSpace(m) != "" && indentOf(m) <= indent {
					break
				}
				if t := strings.TrimSpace(m); t != "" {
					parts = append(parts, t)
				}
			}
			return strings.Join(parts, " "), true
		case strings.HasPrefix(v, `"`):
			u, err := strconv.Unquote(v)
			if err != nil {
				return v, true
			}
			return u, true
		default:
			return v, true
		}
	}
	return "", false
}

func syncOp(t *testing.T, method string) (summary, desc string) {
	t.Helper()
	path := block(specLines(), 2, "/github-sync:")
	if path == nil {
		t.Fatal("path /github-sync not found in api/openapi.yaml")
	}
	op := block(path, 4, method+":")
	if op == nil {
		t.Fatalf("operation %s /github-sync not found", method)
	}
	s, ok := scalar(op, 6, "summary")
	if !ok {
		t.Fatalf("%s has no summary", method)
	}
	d, ok := scalar(op, 6, "description")
	if !ok {
		t.Fatalf("%s has no description", method)
	}
	return s, strings.Join(strings.Fields(d), " ")
}

var (
	// \bassign\b must not match "unassigned".
	assignRe      = regexp.MustCompile(`(?i)\bassign(s|ed|ment|ments)?\b`)
	allProjectsRe = regexp.MustCompile(`(?i)\b(every|all)\b.{0,60}\bprojects?\b|\bprojects?\b.{0,60}\b(every|all)\b`)
	linkedRepoRe  = regexp.MustCompile(`(?i)\blinked\b.{0,60}(repositor|github_repo_url)|(repositor|github_repo_url).{0,60}\blinked\b`)
)

func mustMatch(t *testing.T, what, text string, re *regexp.Regexp, desc string) {
	t.Helper()
	if !re.MatchString(text) {
		t.Errorf("%s lacks %s:\n%s", what, desc, text)
	}
}

func mustContainAll(t *testing.T, what, text string, words ...string) {
	t.Helper()
	low := strings.ToLower(text)
	for _, w := range words {
		if !strings.Contains(low, strings.ToLower(w)) {
			t.Errorf("%s does not mention %q:\n%s", what, w, text)
		}
	}
}

// AC1 (plus the token-owner assignment of story 88): GET and PUT describe the import.
func TestGitHubSyncSpecDescribesIssueImport(t *testing.T) {
	for _, m := range []string{"get", "put"} {
		t.Run(m, func(t *testing.T) {
			_, d := syncOp(t, m)
			mustContainAll(t, m+" description", d,
				"DPROCESS_GITHUB_TOKEN", "repositor", "import", "open", "unassigned",
				"issue reference", "pull request", "token owner")
			// The assignment and the every/all-projects condition must share a sentence.
			same := false
			for _, sent := range strings.Split(d, ". ") {
				if assignRe.MatchString(sent) && allProjectsRe.MatchString(sent) {
					same = true
				}
			}
			if !same {
				t.Errorf("%s description has no sentence with both an assignment word and every/all near project:\n%s", m, d)
			}
			mustMatch(t, m+" description", d, linkedRepoRe, "linked near repository or github_repo_url")
		})
	}
}

// AC2: last_error also reports import errors, including assignment errors.
// Passes when any sentence naming last_error mentions both.
func TestGitHubSyncSpecGetDescribesImportErrors(t *testing.T) {
	_, d := syncOp(t, "get")
	if !strings.Contains(d, "last_error") {
		t.Fatal("GET description does not mention last_error")
	}
	found := false
	for _, sent := range strings.Split(d, ". ") {
		if strings.Contains(sent, "last_error") && strings.Contains(strings.ToLower(sent), "import") && assignRe.MatchString(sent) {
			found = true
		}
	}
	if !found {
		t.Errorf("no sentence naming last_error mentions both the import and assignment:\n%s", d)
	}
	mustContainAll(t, "GET description", d, "listed")
}

// The edit is additive: the old text stays.
func TestGitHubSyncSpecKeepsStatusCacheText(t *testing.T) {
	_, g := syncOp(t, "get")
	mustContainAll(t, "GET description", g, "--github-sync", "title and state", "linked issues and pull requests",
		"never fails the server", "last_error says what went wrong")
	_, p := syncOp(t, "put")
	mustContainAll(t, "PUT description", p, "runs a sync at once", "last_run_at may still be null",
		"keeps the cached remote_status values", "lives in memory only", "never accepted or returned")
}

// Story 88 made the sync write to GitHub: the descriptions drop the read-only claims.
func TestGitHubSyncSpecDescriptionsNotReadOnly(t *testing.T) {
	for _, m := range []string{"get", "put"} {
		_, d := syncOp(t, m)
		low := strings.ToLower(d)
		for _, bad := range []string{"read-only", "get only", "only reads", "never writes"} {
			if strings.Contains(low, bad) {
				t.Errorf("%s description still says %q:\n%s", m, bad, d)
			}
		}
	}
}

// AC3: the PUT summary is unchanged. The GET summary is not pinned (story 92
// changes it and may not edit this file); it only has to exist.
func TestGitHubSyncSpecSummariesUnchanged(t *testing.T) {
	if s, _ := syncOp(t, "get"); strings.TrimSpace(s) == "" {
		t.Error("GET summary is empty")
	}
	want := "Turn the GitHub status sync on or off while the server is running"
	if s, _ := syncOp(t, "put"); s != want {
		t.Errorf("put summary = %q, want %q", s, want)
	}
}

// AC4: no path, operation, schema, field or status code change.
func TestGitHubSyncSpecContractUnchanged(t *testing.T) {
	lines := specLines()
	path := block(lines, 2, "/github-sync:")
	var ops []string
	for _, l := range path {
		if m := regexp.MustCompile(`^    (\w+):`).FindStringSubmatch(l); m != nil {
			ops = append(ops, m[1])
		}
	}
	if want := []string{"get", "put"}; !reflect.DeepEqual(ops, want) {
		t.Errorf("operations = %v, want %v", ops, want)
	}
	codes := func(method string) []string {
		var out []string
		resp := block(block(path, 4, method+":"), 6, "responses:")
		for _, l := range resp {
			if m := regexp.MustCompile(`^        "(\d+)":`).FindStringSubmatch(l); m != nil {
				out = append(out, m[1])
			}
		}
		return out
	}
	if got, want := codes("get"), []string{"200"}; !reflect.DeepEqual(got, want) {
		t.Errorf("GET status codes = %v, want %v", got, want)
	}
	if got, want := codes("put"), []string{"200", "400", "422"}; !reflect.DeepEqual(got, want) {
		t.Errorf("PUT status codes = %v, want %v", got, want)
	}
	props := func(name string) []string {
		schemas := block(lines, 2, "schemas:")
		var out []string
		for _, l := range block(block(schemas, 4, name+":"), 6, "properties:") {
			if m := regexp.MustCompile(`^        (\w+):`).FindStringSubmatch(l); m != nil {
				out = append(out, m[1])
			}
		}
		sort.Strings(out)
		return out
	}
	if got, want := props("GitHubSync"), []string{"enabled", "last_error", "last_run_at"}; !reflect.DeepEqual(got, want) {
		t.Errorf("GitHubSync properties = %v, want %v", got, want)
	}
	if got, want := props("GitHubSyncUpdate"), []string{"enabled"}; !reflect.DeepEqual(got, want) {
		t.Errorf("GitHubSyncUpdate properties = %v, want %v", got, want)
	}
}

// AC5 (light): the regenerated types carry the new description, so make gen-api was run.
// Each description is found by its operation (the comment block just above
// the get/put line), not by summary text, so a summary change by another
// story does not break this test.
func TestGitHubSyncTypesCarryDescription(t *testing.T) {
	raw, err := os.ReadFile("../../web/src/api/schema.d.ts")
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(raw), "\n")
	ops := map[string]string{
		"get": `get: operations["getGitHubSync"];`,
		"put": `put: operations["setGitHubSync"];`,
	}
	for m, marker := range ops {
		at := -1
		for i, l := range lines {
			if strings.TrimSpace(l) == marker {
				at = i
				break
			}
		}
		if at < 0 {
			t.Fatalf("%s: %s not found in schema.d.ts", m, marker)
		}
		var comment []string
		for i := at - 1; i >= 0; i-- {
			comment = append(comment, lines[i])
			if strings.TrimSpace(lines[i]) == "/**" {
				break
			}
		}
		text := strings.Join(comment, " ")
		mustContainAll(t, m+" comment in schema.d.ts", text,
			"@description", "unassigned", "issue reference", "token owner")
		mustMatch(t, m+" comment in schema.d.ts", text, assignRe, "an assignment word")
	}
}
