package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/dright/dprocess/internal/service"
	"github.com/dright/dprocess/internal/store"
)

// impCap is the largest number of issue references one sync run creates,
// counted across all projects (one GitHub issue created in two projects counts
// as two). The rest follows on later runs; reaching the cap is not an error.
const impCap = 20

// impAssignCap is the largest number of assignment requests one sync run sends,
// counted across all repositories; failed requests count, the token owner
// lookup does not. Reaching it is silent: the rest follows on later runs.
const impAssignCap = 20

// impListQuery is what the import asks GitHub's issue list for: open issues
// with no assignee, oldest first, at GitHub's maximum page size. GitHub pages
// are then followed through the Link header, never by asking for a page number.
var impListQuery = url.Values{
	"state":     {"open"},
	"assignee":  {"none"},
	"sort":      {"created"},
	"direction": {"asc"},
	"per_page":  {"100"},
}

// impRepo is one linked repository: "owner/repo" and the ids of the projects
// that link it, ascending. The first id decides where in the run the repository
// is imported.
type impRepo struct {
	repo string
	ids  []int64
}

// impEntry is one entry of a GitHub issue list. Entries that are pull requests
// carry a "pull_request" key; they are not issues and are skipped.
type impEntry struct {
	Number      int64           `json:"number"`
	Title       string          `json:"title"`
	PullRequest json.RawMessage `json:"pull_request"`
}

// impIsPull tells whether a list entry is really a pull request.
func (e impEntry) impIsPull() bool {
	return len(e.PullRequest) > 0 && string(e.PullRequest) != "null"
}

// importIssues imports the open, unassigned issues of every linked repository
// as issue references: for each of them, every project that links the
// repository and does not have the reference yet gets one. It runs at the start
// of each sync run, before the status refresh, so the new references are
// refreshed in the same run. It needs a token and a project linked to a
// repository; without either it does nothing and that is not an error. Once a
// repository's listing ends, it assigns the issues that every linked project
// now references to the token's owner (see impAssign).
//
// A reference that exists already is left untouched, and an insert that finds
// one (created elsewhere in the meantime) is a silent skip that costs no cap
// slot. At most impCap references are created per run, repositories in order of
// their lowest linked project id and, within a repository, in the order GitHub
// returns them. A bad token or a rate limit ends the run; every other failure
// (an unreadable repository, a bad page, one failed insert) is reported once as
// the first error of the run and the import continues with the rest.
func (y *Syncer) importIssues(ctx context.Context) error {
	if y.Store == nil || y.Client == nil || y.Client.Token == "" {
		return nil // no token: no import, silently
	}
	projects, err := y.Store.ListProjects()
	if err != nil {
		return err
	}
	repos, firstErr := impTargets(projects)
	base := y.Client.impBase()
	created := 0
	st := &impRun{first: firstErr}
	for _, r := range repos {
		var pending []int64 // issues referenced in every linked project, to assign
		page := fmt.Sprintf("%s/repos/%s/issues?%s", base, r.repo, impListQuery.Encode())
		for page != "" && created < impCap {
			if err := ctx.Err(); err != nil {
				return impKeep(st.first, err)
			}
			entries, next, err := y.Client.impIssuesPage(ctx, page)
			if err != nil {
				if impIsFatal(err) {
					return err
				}
				st.first = impKeep(st.first, fmt.Errorf("github import: project %d %s: %w", r.ids[0], r.repo, err))
				break // this repository cannot be listed; the next one still runs
			}
			for _, e := range entries {
				if created >= impCap {
					break
				}
				if e.impIsPull() || e.Number <= 0 {
					continue // not an issue, or no usable number: silently nothing
				}
				complete := true
				for _, pid := range r.ids {
					if err := ctx.Err(); err != nil {
						return impKeep(st.first, err)
					}
					if created >= impCap {
						complete = false
						break
					}
					_, err := y.Store.CreateIssue(pid, store.NewIssue{
						URL:    fmt.Sprintf("https://github.com/%s/issues/%d", r.repo, e.Number),
						Repo:   r.repo,
						Number: e.Number,
						Title:  e.Title,
					})
					switch {
					case err == nil:
						created++
					case errors.Is(err, store.ErrDuplicate):
						// already referenced in this project: silent skip, no cap slot
					default:
						complete = false
						st.first = impKeep(st.first, fmt.Errorf("github import: project %d %s#%d: %w", pid, r.repo, e.Number, err))
					}
				}
				if complete {
					pending = append(pending, e.Number)
				}
			}
			next, err = impNextPage(next, base)
			if err != nil {
				st.first = impKeep(st.first, fmt.Errorf("github import: project %d %s: %w", r.ids[0], r.repo, err))
				next = ""
			}
			page = next
		}
		// Assigning while paging would shrink the assignee=none list under the
		// page numbers, so it waits until this repository's paging has ended.
		if err := y.impAssign(ctx, st, r, pending); err != nil {
			if impIsFatal(err) {
				return err
			}
			return impKeep(st.first, err)
		}
	}
	return st.first
}

// impTargets groups the projects that link a repository by repository, in order
// of their lowest project id, with the project ids ascending inside a group.
// Projects that link nothing are skipped silently; a stored link that is not a
// repository URL is reported and skipped.
func impTargets(projects []*store.Project) ([]impRepo, error) {
	byRepo := map[string][]int64{}
	var firstErr error
	for _, p := range projects {
		if p.GithubRepoURL == "" {
			continue
		}
		repo, _, err := service.ParseRepoURL(p.GithubRepoURL)
		if err != nil {
			firstErr = impKeep(firstErr, fmt.Errorf("github import: project %d: %w", p.ID, err))
			continue
		}
		byRepo[repo] = append(byRepo[repo], p.ID)
	}
	out := make([]impRepo, 0, len(byRepo))
	for repo, ids := range byRepo {
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
		out = append(out, impRepo{repo: repo, ids: ids})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ids[0] < out[j].ids[0] })
	return out, firstErr
}

// impIssuesPage fetches one page of a repository's issue list. next is the raw
// rel="next" target of the Link header ("" when there is none). A rejected
// token or a rate limit returns the fatal sentinel unchanged; every other
// failure is a plain error to report for the repository.
func (c *Client) impIssuesPage(ctx context.Context, page string) (entries []impEntry, next string, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, page, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "dprocess")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.impHTTP().Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if err := impFatal(resp); err != nil {
		return nil, "", err
	}
	// Unlike a single item, a repository that answers 404 or 403 here is not
	// "gone": a linked repository the user cannot read is an error to show.
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("GitHub answered %d", resp.StatusCode)
	}
	var out []impEntry
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, "", fmt.Errorf("unreadable GitHub response: %w", err)
	}
	return out, impNextLink(resp), nil
}

// impLinkRe splits one part of a Link header into its URL and its rel.
var impLinkRe = regexp.MustCompile(`^\s*<([^>]*)>(?:\s*;\s*rel=?"?([^",;\s]+)"?)?\s*$`)

// impNextLink returns the rel="next" target of a list response ("" when its
// Link header has none, which ends the paging).
func impNextLink(resp *http.Response) string {
	for _, part := range strings.Split(resp.Header.Get("Link"), ",") {
		if m := impLinkRe.FindStringSubmatch(part); m != nil && m[2] == "next" {
			return strings.TrimSpace(m[1])
		}
	}
	return ""
}

// impNextPage resolves a rel="next" target against the API base ("" stays "")
// and refuses one that points at another scheme or host: the token must never
// travel to a third-party host.
func impNextPage(target, base string) (string, error) {
	if target == "" {
		return "", nil
	}
	u, err := url.Parse(target)
	if err != nil {
		return "", fmt.Errorf("unreadable GitHub Link header: %w", err)
	}
	b, err := url.Parse(base)
	if err != nil {
		return "", fmt.Errorf("unusable GitHub API base: %w", err)
	}
	u = b.ResolveReference(u)
	if !strings.EqualFold(u.Scheme, b.Scheme) || !strings.EqualFold(u.Host, b.Host) {
		return "", fmt.Errorf("GitHub pointed to another host (%s)", u.Host)
	}
	return u.String(), nil
}

// impFatal is the fatal GitHub failure behind an answer: a rejected token or a
// rate limit. The same failure would hit everything else, so it ends the run.
func impFatal(resp *http.Response) error {
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return ErrBadToken
	case resp.StatusCode == http.StatusTooManyRequests,
		resp.StatusCode == http.StatusForbidden && resp.Header.Get("X-RateLimit-Remaining") == "0":
		return ErrRateLimited
	}
	return nil
}

// impIsFatal tells whether an import failure ends the whole run.
func impIsFatal(err error) bool {
	return errors.Is(err, ErrBadToken) || errors.Is(err, ErrRateLimited)
}

// impKeep keeps the first error of a run.
func impKeep(first, err error) error {
	if first != nil {
		return first
	}
	return err
}

// impRun is the state of one import run that the assignment shares with the
// reference walk: the first error, the assignment requests sent so far and
// whether the token owner was already asked for in this run.
type impRun struct {
	first   error
	posts   int
	lookups int
}

// impAssign assigns the given issues of repository r to the token's owner, in
// order, up to impAssignCap requests per run. It returns only what ends the
// run (a fatal failure or the cancelled context); other failures are kept in
// st as the first error of the run and the next issue is tried.
func (y *Syncer) impAssign(ctx context.Context, st *impRun, r impRepo, numbers []int64) error {
	for _, n := range numbers {
		if st.posts >= impAssignCap {
			return nil // silent: later runs assign the rest
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		login, err := y.impOwner(ctx, st)
		if err != nil {
			return err
		}
		if login == "" {
			return nil // lookup failed (kept as the error): no assignment this run
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		st.posts++
		err = y.Client.impAssignIssue(ctx, r.repo, n, login)
		if err == nil {
			continue
		}
		if ctx.Err() != nil {
			return ctx.Err() // cut short by the cancellation: not an assign error
		}
		if impIsFatal(err) {
			return err
		}
		st.first = impKeep(st.first, fmt.Errorf("github assign: project %d %s#%d: %w", r.ids[0], r.repo, n, err))
	}
	return nil
}

// impOwner returns the login of the token's owner: the cached one, else GET
// /user, at most once per run (a failed lookup is recorded and not repeated in
// this run, nor cached). An empty login with a nil error means the lookup
// failed non-fatally.
func (y *Syncer) impOwner(ctx context.Context, st *impRun) (string, error) {
	y.mu.Lock()
	login := y.owner
	y.mu.Unlock()
	if login != "" {
		return login, nil
	}
	if st.lookups > 0 {
		return "", nil
	}
	st.lookups++
	login, err := y.Client.impUser(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if impIsFatal(err) {
			return "", err
		}
		st.first = impKeep(st.first, fmt.Errorf("github assign: cannot determine the token owner: %w", err))
		return "", nil
	}
	y.mu.Lock()
	y.owner = login
	y.mu.Unlock()
	return login, nil
}

// impWriteFatal is impFatal for the requests that write or look up the token's
// owner: a 403 with a Retry-After header (GitHub's secondary limits) is a rate
// limit there too. List and refresh requests keep impFatal.
func impWriteFatal(resp *http.Response) error {
	if err := impFatal(resp); err != nil {
		return err
	}
	if resp.StatusCode == http.StatusForbidden && resp.Header.Get("Retry-After") != "" {
		return ErrRateLimited
	}
	return nil
}

// impSend sends a request to the API base with the token and the usual headers.
func (c *Client) impSend(ctx context.Context, method, target string, body []byte) (*http.Response, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "dprocess")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	return c.impHTTP().Do(req)
}

// impUser asks GitHub who owns the token (GET /user).
func (c *Client) impUser(ctx context.Context) (string, error) {
	resp, err := c.impSend(ctx, http.MethodGet, c.impBase()+"/user", nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if err := impWriteFatal(resp); err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GitHub answered %d", resp.StatusCode)
	}
	var u struct {
		Login string `json:"login"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&u); err != nil {
		return "", fmt.Errorf("unreadable GitHub response: %w", err)
	}
	if u.Login == "" {
		return "", errors.New("unreadable GitHub response: no login")
	}
	return u.Login, nil
}

// impAssignIssue adds login as an assignee of one issue. The URL is built from
// the linked repository and the number. GitHub may answer success and still
// drop an assignee without push access, so the answer must list login.
func (c *Client) impAssignIssue(ctx context.Context, repo string, number int64, login string) error {
	body, err := json.Marshal(map[string][]string{"assignees": {login}})
	if err != nil {
		return err
	}
	resp, err := c.impSend(ctx, http.MethodPost,
		fmt.Sprintf("%s/repos/%s/issues/%d/assignees", c.impBase(), repo, number), body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := impWriteFatal(resp); err != nil {
		return err
	}
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GitHub answered %d", resp.StatusCode)
	}
	var out struct {
		Assignees []struct {
			Login string `json:"login"`
		} `json:"assignees"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return fmt.Errorf("unreadable GitHub response: %w", err)
	}
	for _, a := range out.Assignees {
		if strings.EqualFold(a.Login, login) {
			return nil
		}
	}
	return fmt.Errorf("GitHub did not assign %s (the token needs write access to issues)", login)
}
