package service

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// Validation errors; the API maps them to 422.
var (
	ErrInvalidTag      = errors.New("invalid tag")
	ErrInvalidIssueURL = errors.New("invalid GitHub issue URL")
	// ErrInvalidPullRequestURL is returned for anything but a github.com pull request URL.
	ErrInvalidPullRequestURL = errors.New("invalid GitHub pull request URL")
)

var tagRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._:-]{0,49}$`)

// NormalizeTag trims and lowercases a tag and checks it against
// ^[a-z0-9][a-z0-9._:-]{0,49}$.
func NormalizeTag(raw string) (string, error) {
	t := strings.ToLower(strings.TrimSpace(raw))
	if !tagRe.MatchString(t) {
		return "", fmt.Errorf("%w: %q (use 1-50 chars of a-z, 0-9, '.', '_', ':', '-', starting with a letter or digit)", ErrInvalidTag, raw)
	}
	return t, nil
}

var (
	issuePathRe = regexp.MustCompile(`^/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/issues/([0-9]+)/?$`)
	pullPathRe  = regexp.MustCompile(`^/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/([0-9]+)/?$`)
)

// ParseIssueURL accepts only https://github.com/{owner}/{repo}/issues/{number}
// (optional trailing slash, no query string or fragment) and returns the
// lower-cased "owner/repo", the issue number and the canonical URL. GitHub
// treats owner and repo names case-insensitively.
func ParseIssueURL(raw string) (repo string, number int64, canonical string, err error) {
	return parseGitHubURL(raw, "issues", issuePathRe, ErrInvalidIssueURL)
}

// ParsePullRequestURL accepts only https://github.com/{owner}/{repo}/pull/{number}
// under the same rules as ParseIssueURL (issue URLs are rejected).
func ParsePullRequestURL(raw string) (repo string, number int64, canonical string, err error) {
	return parseGitHubURL(raw, "pull", pullPathRe, ErrInvalidPullRequestURL)
}

// parseGitHubURL validates https://github.com/{owner}/{repo}/{segment}/{number}.
func parseGitHubURL(raw, segment string, pathRe *regexp.Regexp, kind error) (repo string, number int64, canonical string, err error) {
	bad := func(why string) (string, int64, string, error) {
		return "", 0, "", fmt.Errorf("%w: %s (expected https://github.com/{owner}/{repo}/%s/{number})", kind, why, segment)
	}
	u, perr := url.Parse(strings.TrimSpace(raw))
	if perr != nil {
		return bad("not a valid URL")
	}
	if u.Scheme != "https" || u.Host != "github.com" || u.User != nil {
		return bad("must be an https://github.com URL")
	}
	if u.RawQuery != "" || u.Fragment != "" || u.ForceQuery {
		return bad("query strings and fragments are not allowed")
	}
	m := pathRe.FindStringSubmatch(u.EscapedPath())
	if m == nil {
		return bad("path must be /{owner}/{repo}/" + segment + "/{number}")
	}
	for _, part := range m[1:3] {
		if strings.Trim(part, ".") == "" {
			return bad("invalid owner or repository name")
		}
	}
	n, perr := strconv.ParseInt(m[3], 10, 64)
	if perr != nil || n <= 0 {
		return bad("the number must be a positive integer")
	}
	repo = strings.ToLower(m[1] + "/" + m[2])
	return repo, n, fmt.Sprintf("https://github.com/%s/%s/%d", repo, segment, n), nil
}
