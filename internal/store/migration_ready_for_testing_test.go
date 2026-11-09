package store

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// An existing database (schema up to migration 0005) keeps all of its rows,
// including dependent rows and state history, when 0006 rebuilds stories.
func TestReadyForTestingMigrationKeepsData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY,
		applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"0001_init.sql", "0002_issue_unique.sql", "0003_story_pull_requests.sql", "0004_github_status.sql", "0005_story_pr_review.sql"} {
		body, _ := migrationFS.ReadFile("migrations/" + name)
		if _, err := db.Exec(string(body)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		db.Exec(`INSERT INTO schema_migrations(version) VALUES (?)`, name)
	}
	for _, q := range []string{
		`INSERT INTO projects(name) VALUES ('p')`,
		`INSERT INTO epics(project_id, name, state) VALUES (1, 'e', 'ready')`,
		`INSERT INTO stories(project_id, epic_id, name, state) VALUES (1, 1, 'a', 'pr_review'), (1, 1, 'b', 'finished')`,
		`INSERT INTO story_dependencies(story_id, depends_on_id) VALUES (1, 2)`,
		`INSERT INTO story_pull_requests(story_id, github_url, github_repo, number) VALUES (1, 'https://github.com/o/r/pull/1', 'o/r', 1)`,
		`INSERT INTO issues(project_id, story_id, github_url) VALUES (1, 1, 'https://github.com/o/r/issues/2')`,
		`INSERT INTO state_history(entity_type, entity_id, from_state, to_state) VALUES ('story', 2, 'pr_review', 'finished')`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	db.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	count := func(q string) (n int) {
		if err := s.DB.QueryRow(q).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return
	}
	for q, want := range map[string]int{
		`SELECT count(*) FROM stories`:                                      2,
		`SELECT count(*) FROM stories WHERE state='pr_review' AND id=1`:       1,
		`SELECT count(*) FROM story_dependencies`:                           1,
		`SELECT count(*) FROM story_pull_requests`:                          1,
		`SELECT count(*) FROM issues WHERE story_id = 1`:                    1,
		`SELECT count(*) FROM state_history WHERE to_state='finished'`:      1, // history is left as it was
		`SELECT count(*) FROM pragma_foreign_keys WHERE foreign_keys = 1`:   1, // enforcement restored
		`SELECT count(*) FROM sqlite_master WHERE name = 'stories_epic'`:    1,
		`SELECT count(*) FROM sqlite_master WHERE name = 'stories_project'`: 1,
	} {
		if got := count(q); got != want {
			t.Errorf("%s: got %d, want %d", q, got, want)
		}
	}
	if _, err := s.DB.Exec(`UPDATE stories SET state = 'ready_for_testing' WHERE id = 1`); err != nil {
		t.Errorf("ready_for_testing should be accepted: %v", err)
	}
	if _, err := s.DB.Exec(`UPDATE stories SET state = 'bogus' WHERE id = 1`); err == nil {
		t.Error("bogus state should be rejected")
	}
	if _, err := s.DB.Exec(`INSERT INTO story_dependencies(story_id, depends_on_id) VALUES (1, 99)`); err == nil {
		t.Error("foreign keys should be enforced after migrating")
	}
}
