import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";
import { formatTime } from "../lib/format";

/**
 * Turns the server's GitHub status sync on or off. The state shown always
 * comes from the server (no optimistic update); the switch is disabled while
 * a request is in flight. Shares the ["github-sync"] query with RemoteStatusBadge.
 */
export default function GitHubSyncPanel() {
  const queryClient = useQueryClient();
  const state = useQuery({
    queryKey: ["github-sync"],
    queryFn: () => unwrap(api.GET("/github-sync")),
    retry: false,
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => unwrap(api.PUT("/github-sync", { body: { enabled } })),
    onSuccess: (status) => {
      queryClient.setQueryData(["github-sync"], status);
      void queryClient.invalidateQueries({ queryKey: ["github-sync"] });
    },
  });

  const sync = state.data;
  return (
    <section aria-label="GitHub status sync" className="sync-panel">
      {state.isError ? (
        <p role="alert" className="error">
          Could not load the GitHub status sync state: {state.error.message}
        </p>
      ) : sync ? (
        <>
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              aria-label="GitHub status sync"
              checked={sync.enabled}
              disabled={toggle.isPending}
              onChange={(e) => toggle.mutate(e.target.checked)}
            />
            <span>{sync.enabled ? "On" : "Off"}</span>
          </label>
          {sync.enabled && sync.last_run_at && <p className="meta">Last run: {formatTime(sync.last_run_at)}</p>}
          {sync.enabled && sync.last_error && (
            <p role="alert" className="error">
              {sync.last_error}
            </p>
          )}
          {toggle.isError && (
            <p role="alert" className="error">
              {toggle.error.message}
            </p>
          )}
        </>
      ) : (
        <p>Loading...</p>
      )}
    </section>
  );
}
