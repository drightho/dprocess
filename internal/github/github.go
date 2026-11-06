// Package github is the optional, strictly read-only GitHub status sync. It
// only issues GET requests and caches the title and open/closed/merged state of
// the issues and pull requests that DProcess already links to.
package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/dright/dprocess/internal/store"
)

// DefaultAPI is the public GitHub REST API.
const DefaultAPI = "https://api.github.com"

// Fatal errors end a sync run (the same failure would hit every item).
var (
	ErrBadToken    = errors.New("GitHub rejected the token (401): check DPROCESS_GITHUB_TOKEN")
	ErrRateLimited = errors.New("GitHub rate limit reached: set DPROCESS_GITHUB_TOKEN for a higher limit")
)

// errGone means the item does not exist or is not visible with this token.
var errGone = errors.New("not found")

// Client reads issue and pull request status. Token may be empty (public
// repositories only, low rate limit).
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

type remoteItem struct {
	Title  string `json:"title"`
	State  string `json:"state"`
	Merged bool   `json:"merged"`
}

// Fetch returns the title and state (open, closed or merged) of one item.
func (c *Client) Fetch(ctx context.Context, it store.RemoteItem) (title, state string, err error) {
	path := "issues"
	if it.Kind == store.KindPull {
		path = "pulls"
	}
	base := strings.TrimRight(c.BaseURL, "/")
	if base == "" {
		base = DefaultAPI
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/repos/%s/%s/%d", base, it.Repo, path, it.Number), nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "dprocess")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 15 * time.Second}
	}
	resp, err := hc.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return "", "", ErrBadToken
	case resp.StatusCode == http.StatusTooManyRequests,
		resp.StatusCode == http.StatusForbidden && resp.Header.Get("X-RateLimit-Remaining") == "0":
		return "", "", ErrRateLimited
	case resp.StatusCode == http.StatusNotFound, resp.StatusCode == http.StatusForbidden:
		return "", "", errGone
	case resp.StatusCode != http.StatusOK:
		return "", "", fmt.Errorf("GitHub answered %d", resp.StatusCode)
	}
	var r remoteItem
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return "", "", fmt.Errorf("unreadable GitHub response: %w", err)
	}
	state = r.State
	if r.Merged {
		state = "merged"
	}
	if state != "open" && state != "closed" && state != "merged" {
		return "", "", fmt.Errorf("unexpected GitHub state %q", r.State)
	}
	return r.Title, state, nil
}

// Status is what the sync reports about itself.
type Status struct {
	Enabled   bool    `json:"enabled"`
	LastRunAt *string `json:"last_run_at"`
	LastError string  `json:"last_error"`
}

// Syncer periodically refreshes the cached status of every linked item.
type Syncer struct {
	Store    *store.Store
	Client   *Client
	Interval time.Duration

	mu      sync.Mutex
	lastRun *string
	lastErr string
}

// Status reports the last run. A nil Syncer means the sync is disabled.
func (y *Syncer) Status() Status {
	if y == nil {
		return Status{}
	}
	y.mu.Lock()
	defer y.mu.Unlock()
	return Status{Enabled: true, LastRunAt: y.lastRun, LastError: y.lastErr}
}

// RunOnce refreshes every linked item. Items that cannot be read keep their
// old (eventually stale, hence unknown) status; a bad token or rate limit ends
// the run. It never writes to GitHub and never fails the server.
func (y *Syncer) RunOnce(ctx context.Context) {
	runErr := y.sync(ctx)
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	y.mu.Lock()
	defer y.mu.Unlock()
	y.lastRun = &now
	y.lastErr = ""
	if runErr != nil {
		y.lastErr = runErr.Error()
	}
}

func (y *Syncer) sync(ctx context.Context) error {
	items, err := y.Store.RemoteItems()
	if err != nil {
		return err
	}
	var firstErr error
	for _, it := range items {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		title, state, err := y.Client.Fetch(ctx, it)
		switch {
		case errors.Is(err, ErrBadToken), errors.Is(err, ErrRateLimited):
			return err
		case errors.Is(err, errGone):
			err = y.Store.ClearRemoteStatus(it)
		case err == nil:
			err = y.Store.SetRemoteStatus(it, title, state, time.Now())
		}
		if err != nil && firstErr == nil {
			firstErr = fmt.Errorf("%s %s#%d: %w", it.Kind, it.Repo, it.Number, err)
		}
	}
	return firstErr
}

// Run syncs now and then every Interval until ctx ends.
func (y *Syncer) Run(ctx context.Context) {
	t := time.NewTicker(y.Interval)
	defer t.Stop()
	for {
		y.RunOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
