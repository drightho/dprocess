package api

import (
	"github.com/dright/dprocess/internal/service"
	"github.com/dright/dprocess/internal/store"
)

// projectRepo returns the project's linked repository URL ("" when none).
func (s *Server) projectRepo(projectID int64) (string, error) {
	p, err := s.Store.GetProject(projectID)
	if err != nil {
		return "", err
	}
	return p.GithubRepoURL, nil
}

// warnIssues sets the repo_mismatch warnings of issues from their project's link.
func (s *Server) warnIssues(projectID int64, issues ...*store.Issue) error {
	repo, err := s.projectRepo(projectID)
	if err != nil {
		return err
	}
	for _, i := range issues {
		i.Warnings = service.RepoMismatchWarning(repo, i.GitHubRepo)
	}
	return nil
}

// warnPullRequests sets the warnings of pull requests of a story from the
// story's project (story -> project).
func (s *Server) warnPullRequests(storyID int64, prs ...*store.PullRequest) error {
	st, err := s.Store.GetStory(storyID)
	if err != nil {
		return err
	}
	repo, err := s.projectRepo(st.ProjectID)
	if err != nil {
		return err
	}
	for _, p := range prs {
		p.Warnings = service.RepoMismatchWarning(repo, p.GitHubRepo)
	}
	return nil
}
