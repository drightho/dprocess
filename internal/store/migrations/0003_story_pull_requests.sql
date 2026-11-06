-- GitHub pull requests linked to a story. Only canonical
-- https://github.com/{owner}/{repo}/pull/{number} URLs are stored.
CREATE TABLE story_pull_requests (
    id          INTEGER PRIMARY KEY,
    story_id    INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    github_url  TEXT NOT NULL CHECK (length(github_url) > 0),
    github_repo TEXT NOT NULL,
    number      INTEGER NOT NULL CHECK (number > 0),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (story_id, github_repo, number)
);
CREATE INDEX story_pull_requests_story ON story_pull_requests(story_id);
