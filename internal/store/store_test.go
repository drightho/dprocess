package store

import (
	"path/filepath"
	"testing"
)

func TestOpenMigratesAndPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.db")

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB.Exec(`INSERT INTO projects(name) VALUES ('p1')`); err != nil {
		t.Fatal(err)
	}
	s.Close()

	// Reopen: data persists and migrations are not re-applied.
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var name string
	if err := s.DB.QueryRow(`SELECT name FROM projects`).Scan(&name); err != nil || name != "p1" {
		t.Fatalf("got %q, %v", name, err)
	}
	var n int
	s.DB.QueryRow(`SELECT count(*) FROM schema_migrations`).Scan(&n)
	if n != 1 {
		t.Fatalf("expected 1 migration row, got %d", n)
	}
}

func TestForeignKeysEnforced(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "fk.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.DB.Exec(`INSERT INTO epics(project_id, name) VALUES (999, 'e')`); err == nil {
		t.Fatal("expected foreign key violation")
	}
}

func TestInvalidStateRejected(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "st.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.DB.Exec(`INSERT INTO projects(name) VALUES ('p')`)
	if _, err := s.DB.Exec(`INSERT INTO epics(project_id, name, state) VALUES (1, 'e', 'bogus')`); err == nil {
		t.Fatal("expected check violation")
	}
}
