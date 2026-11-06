/** "owner/repo#42": how an issue or pull request is named in the UI. */
export const githubLabel = (x: { github_repo: string; number: number }): string => `${x.github_repo}#${x.number}`;
