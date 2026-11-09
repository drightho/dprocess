-- Adds the story state 'ready_for_testing' (between implementation and
-- testing). SQLite cannot alter a CHECK constraint, so the stories table is
-- rebuilt, exactly as in 0005. The migration runner turns foreign key
-- enforcement off around migrations, so dropping the old table does not
-- cascade into story_dependencies, story_pull_requests or issues. Existing
-- rows are copied and state_history is left untouched.
CREATE TABLE stories_new (
    id                  INTEGER PRIMARY KEY,
    project_id          INTEGER NOT NULL REFERENCES projects(id),
    epic_id             INTEGER NOT NULL REFERENCES epics(id),
    name                TEXT NOT NULL CHECK (length(name) > 0),
    description         TEXT NOT NULL DEFAULT '',
    acceptance_criteria TEXT NOT NULL DEFAULT '',
    state               TEXT NOT NULL DEFAULT 'draft'
                        CHECK (state IN ('draft','review','design','implementation','ready_for_testing','testing','pr_review','finished','cancelled')),
    estimate_loc        INTEGER CHECK (estimate_loc IS NULL OR estimate_loc >= 0),
    assignee            TEXT NOT NULL DEFAULT '',
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO stories_new(id, project_id, epic_id, name, description, acceptance_criteria, state, estimate_loc, assignee, created_at, updated_at)
    SELECT id, project_id, epic_id, name, description, acceptance_criteria, state, estimate_loc, assignee, created_at, updated_at FROM stories;
DROP TABLE stories;
ALTER TABLE stories_new RENAME TO stories;
CREATE INDEX stories_project ON stories(project_id);
CREATE INDEX stories_epic ON stories(epic_id);
