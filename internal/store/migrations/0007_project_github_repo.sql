-- A project can optionally be linked to a GitHub repository (canonical
-- https://github.com/{owner}/{repo}). NULL means no link.
ALTER TABLE projects ADD COLUMN github_repo_url TEXT;
