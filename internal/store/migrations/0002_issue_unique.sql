-- An issue can be referenced only once per project.
CREATE UNIQUE INDEX issues_unique_ref ON issues(project_id, github_repo, number);
