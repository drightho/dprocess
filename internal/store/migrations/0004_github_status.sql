-- Cached read-only status of GitHub issues and pull requests, filled by the
-- optional GitHub sync. Keyed by the remote item, not by the link, so it is
-- independent of (frozen) stories and shared by every link to the same item.
CREATE TABLE github_status (
    kind        TEXT NOT NULL CHECK (kind IN ('issue', 'pull')),
    github_repo TEXT NOT NULL,
    number      INTEGER NOT NULL,
    title       TEXT NOT NULL,
    state       TEXT NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
    checked_at  TEXT NOT NULL,
    PRIMARY KEY (kind, github_repo, number)
);
