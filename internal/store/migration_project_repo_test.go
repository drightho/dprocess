package store

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// An existing database (schema up to migration 0006) keeps its projects and
// reports no repository link after migration 0007.
func TestProjectRepoMigration(t *testing.T) {
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
	for _, name := range []string{"0001_init.sql", "0002_issue_unique.sql", "0003_story_pull_requests.sql", "0004_github_status.sql", "0005_story_pr_review.sql", "0006_story_ready_for_testing.sql"} {
		body, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(string(body)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		db.Exec(`INSERT INTO schema_migrations(version) VALUES (?)`, name)
	}
	for _, q := range []string{
		`INSERT INTO projects(name, description) VALUES ('old', 'kept')`,
		`INSERT INTO epics(project_id, name, state) VALUES (1, 'e', 'ready')`,
		`INSERT INTO issues(project_id, github_url) VALUES (1, 'https://github.com/o/r/issues/2')`,
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

	p, err := s.GetProject(1)
	if err != nil || p.Name != "old" || p.Description != "kept" || p.GithubRepoURL != "" {
		t.Fatalf("migrated project: %+v %v", p, err)
	}
	var notnull int
	if err := s.DB.QueryRow(`SELECT "notnull" FROM pragma_table_info('projects') WHERE name = 'github_repo_url'`).Scan(&notnull); err != nil {
		t.Fatalf("column github_repo_url missing: %v", err)
	}
	if notnull != 0 {
		t.Error("github_repo_url must be nullable")
	}
	var n int
	s.DB.QueryRow(`SELECT count(*) FROM issues`).Scan(&n)
	if n != 1 {
		t.Errorf("issues kept: %d", n)
	}
	var applied int
	s.DB.QueryRow(`SELECT count(*) FROM schema_migrations WHERE version LIKE '0007%'`).Scan(&applied)
	if applied != 1 {
		t.Errorf("0007 recorded %d times", applied)
	}

	// New projects work, store round trip, and clearing.
	q, err := s.CreateProject("new", "")
	if err != nil || q.GithubRepoURL != "" {
		t.Fatalf("new project: %+v %v", q, err)
	}
	url := "https://github.com/o/r"
	if q, err = s.UpdateProject(q.ID, nil, nil, &url); err != nil || q.GithubRepoURL != url {
		t.Fatalf("set link: %+v %v", q, err)
	}
	name := "renamed"
	if q, err = s.UpdateProject(q.ID, &name, nil, nil); err != nil || q.GithubRepoURL != url || q.Name != name {
		t.Fatalf("nil leaves link: %+v %v", q, err)
	}
	empty := ""
	if q, err = s.UpdateProject(q.ID, nil, nil, &empty); err != nil || q.GithubRepoURL != "" {
		t.Fatalf("clear link: %+v %v", q, err)
	}
}
