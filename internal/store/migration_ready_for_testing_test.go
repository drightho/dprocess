package store

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// A database at migration 0005 keeps all of its rows when 0006 rebuilds
// stories with ready_for_testing in the state CHECK.
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
		body, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(string(body)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		db.Exec(`INSERT INTO schema_migrations(version) VALUES (?)`, name)
	}
	states := []string{"draft", "review", "design", "implementation", "testing", "pr_review", "finished", "cancelled"}
	setup := []string{
		`INSERT INTO projects(name) VALUES ('p')`,
		`INSERT INTO epics(project_id, name, state) VALUES (1, 'e', 'ready')`,
	}
	for _, st := range states {
		setup = append(setup, `INSERT INTO stories(project_id, epic_id, name, state) VALUES (1, 1, 's-`+st+`', '`+st+`')`)
	}
	setup = append(setup,
		`INSERT INTO story_dependencies(story_id, depends_on_id) VALUES (1, 2)`,
		`INSERT INTO story_pull_requests(story_id, github_url, github_repo, number) VALUES (5, 'https://github.com/o/r/pull/1', 'o/r', 1)`,
		`INSERT INTO issues(project_id, story_id, github_url) VALUES (1, 4, 'https://github.com/o/r/issues/2')`,
		// Old history: the direct implementation -> testing edge, removed by this change.
		`INSERT INTO state_history(entity_type, entity_id, from_state, to_state) VALUES ('story', 5, 'implementation', 'testing')`,
	)
	for _, q := range setup {
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
		`SELECT count(*) FROM schema_migrations WHERE version = '0006_story_ready_for_testing.sql'`: 1,
		`SELECT count(*) FROM stories`:                                                                8,
		`SELECT count(*) FROM stories WHERE name = 's-' || state`:                                     8, // every state kept
		`SELECT count(*) FROM story_dependencies`:                                                     1,
		`SELECT count(*) FROM story_pull_requests WHERE story_id = 5`:                                 1,
		`SELECT count(*) FROM issues WHERE story_id = 4`:                                              1,
		`SELECT count(*) FROM state_history`:                                                          1,
		`SELECT count(*) FROM state_history WHERE from_state='implementation' AND to_state='testing'`: 1,
		`SELECT count(*) FROM pragma_foreign_keys WHERE foreign_keys = 1`:                             1,
		`SELECT count(*) FROM sqlite_master WHERE name = 'stories_epic'`:                              1,
		`SELECT count(*) FROM sqlite_master WHERE name = 'stories_project'`:                           1,
		`SELECT count(*) FROM pragma_foreign_key_check`:                                               0,
	} {
		if got := count(q); got != want {
			t.Errorf("%s: got %d, want %d", q, got, want)
		}
	}
	if _, err := s.DB.Exec(`UPDATE stories SET state = 'ready_for_testing' WHERE id = 4`); err != nil {
		t.Errorf("ready_for_testing should be accepted: %v", err)
	}
	if _, err := s.DB.Exec(`UPDATE stories SET state = 'bogus' WHERE id = 4`); err == nil {
		t.Error("bogus state should be rejected")
	}
	if _, err := s.DB.Exec(`UPDATE stories SET state = 'ready-for-testing' WHERE id = 4`); err == nil {
		t.Error("hyphenated spelling should be rejected")
	}
	if _, err := s.DB.Exec(`INSERT INTO story_dependencies(story_id, depends_on_id) VALUES (1, 99)`); err == nil {
		t.Error("foreign keys should be enforced after migrating")
	}
}
