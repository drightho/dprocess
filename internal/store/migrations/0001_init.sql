CREATE TABLE projects (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL CHECK (length(name) > 0),
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE epics (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL REFERENCES projects(id),
    name        TEXT NOT NULL CHECK (length(name) > 0),
    description TEXT NOT NULL DEFAULT '',
    state       TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','review','ready','finished','cancelled')),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX epics_project ON epics(project_id);

CREATE TABLE stories (
    id                  INTEGER PRIMARY KEY,
    project_id          INTEGER NOT NULL REFERENCES projects(id),
    epic_id             INTEGER NOT NULL REFERENCES epics(id),
    name                TEXT NOT NULL CHECK (length(name) > 0),
    description         TEXT NOT NULL DEFAULT '',
    acceptance_criteria TEXT NOT NULL DEFAULT '',
    state               TEXT NOT NULL DEFAULT 'draft'
                        CHECK (state IN ('draft','review','design','implementation','testing','finished','cancelled')),
    estimate_loc        INTEGER CHECK (estimate_loc IS NULL OR estimate_loc >= 0),
    assignee            TEXT NOT NULL DEFAULT '',
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX stories_project ON stories(project_id);
CREATE INDEX stories_epic ON stories(epic_id);

CREATE TABLE story_dependencies (
    story_id      INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    depends_on_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    PRIMARY KEY (story_id, depends_on_id),
    CHECK (story_id <> depends_on_id)
);

CREATE TABLE state_history (
    id          INTEGER PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('epic','story')),
    entity_id   INTEGER NOT NULL,
    from_state  TEXT NOT NULL,
    to_state    TEXT NOT NULL,
    reason      TEXT NOT NULL DEFAULT '',
    actor       TEXT NOT NULL DEFAULT '',
    at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX state_history_entity ON state_history(entity_type, entity_id);

CREATE TABLE comments (
    id          INTEGER PRIMARY KEY,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('epic','story')),
    entity_id   INTEGER NOT NULL,
    body        TEXT NOT NULL CHECK (length(body) > 0),
    author      TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX comments_entity ON comments(entity_type, entity_id);

CREATE TABLE entity_tags (
    entity_type TEXT NOT NULL CHECK (entity_type IN ('epic','story')),
    entity_id   INTEGER NOT NULL,
    tag         TEXT NOT NULL CHECK (length(tag) > 0),
    PRIMARY KEY (entity_type, entity_id, tag)
);

CREATE TABLE issues (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL REFERENCES projects(id),
    story_id    INTEGER REFERENCES stories(id) ON DELETE SET NULL,
    github_url  TEXT NOT NULL CHECK (length(github_url) > 0),
    github_repo TEXT NOT NULL DEFAULT '',
    number      INTEGER,
    title_cache TEXT NOT NULL DEFAULT '',
    kind        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX issues_project ON issues(project_id);
CREATE INDEX issues_story ON issues(story_id);
