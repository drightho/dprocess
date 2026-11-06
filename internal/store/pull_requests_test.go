package store

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestPullRequestsDeletedWithTheirStory(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "pr.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	p, _ := s.CreateProject("P", "")
	e, _ := s.CreateEpic(p.ID, "E", "")
	st, _ := s.CreateStory(e.ID, NewStory{Name: "s"})
	other, _ := s.CreateStory(e.ID, NewStory{Name: "o"})

	if _, err := s.AddPullRequest(st.ID, "https://github.com/a/b/pull/1", "a/b", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddPullRequest(other.ID, "https://github.com/a/b/pull/1", "a/b", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddPullRequest(st.ID, "https://github.com/a/b/pull/1", "a/b", 1); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("duplicate: %v", err)
	}

	if err := s.DeleteStory(st.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	s.DB.QueryRow(`SELECT count(*) FROM story_pull_requests WHERE story_id = ?`, st.ID).Scan(&n)
	if n != 0 {
		t.Fatalf("orphaned pull request rows: %d", n)
	}
	// The other story's link is untouched.
	if prs, _ := s.ListPullRequests(other.ID); len(prs) != 1 {
		t.Fatalf("other story's links: %v", prs)
	}
}

func TestPullRequestTableRejectsBadRows(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "pr2.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.DB.Exec(`INSERT INTO story_pull_requests(story_id, github_url, github_repo, number) VALUES (999, 'u', 'a/b', 1)`); err == nil {
		t.Fatal("expected foreign key violation")
	}
}
