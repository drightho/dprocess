package service

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// ErrInvalidRepoURL is returned for anything but a github.com repository URL.
var ErrInvalidRepoURL = fmt.Errorf("invalid GitHub repository URL")

var repoPathRe = regexp.MustCompile(`^/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$`)

// ParseRepoURL accepts only https://github.com/{owner}/{repo}. The input is
// trimmed; one trailing slash and one trailing ".git" (case-insensitive, only
// when something remains before it) are stripped. It returns the lower-cased
// "owner/repo" and the canonical URL (https://github.com/owner/repo).
func ParseRepoURL(raw string) (repo, canonical string, err error) {
	bad := func(why string) (string, string, error) {
		return "", "", fmt.Errorf("%w: %s (expected https://github.com/{owner}/{repo})", ErrInvalidRepoURL, why)
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
	path := strings.TrimSuffix(u.EscapedPath(), "/")
	if len(path) > 4 && strings.EqualFold(path[len(path)-4:], ".git") {
		path = path[:len(path)-4]
	}
	m := repoPathRe.FindStringSubmatch(path)
	if m == nil {
		return bad("path must be /{owner}/{repo}")
	}
	for _, part := range m[1:3] {
		if strings.Trim(part, ".") == "" {
			return bad("invalid owner or repository name")
		}
	}
	repo = strings.ToLower(m[1] + "/" + m[2])
	return repo, "https://github.com/" + repo, nil
}

// RepoMismatchWarning returns the warnings for an issue or pull request in
// itemRepo ("owner/repo") when the project is linked to projectRepoURL (""
// when it is not). It is never nil.
func RepoMismatchWarning(projectRepoURL, itemRepo string) []string {
	w := []string{}
	if projectRepoURL == "" {
		return w
	}
	linked := strings.ToLower(strings.TrimPrefix(strings.TrimSuffix(projectRepoURL, "/"), "https://github.com/"))
	if linked != strings.ToLower(itemRepo) {
		w = append(w, "repo_mismatch")
	}
	return w
}
