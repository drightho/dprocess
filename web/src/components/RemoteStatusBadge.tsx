import { useQuery } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";
import { formatTime } from "../lib/format";
import { remoteDisplay } from "../lib/github";

/** Whether the server runs the optional GitHub status sync. Anything but a clear yes hides the badges. */
function useSyncEnabled(): boolean {
  const q = useQuery({
    queryKey: ["github-sync"],
    queryFn: () => unwrap(api.GET("/github-sync")),
    retry: false,
    staleTime: 60_000,
  });
  return q.data?.enabled === true;
}

/**
 * The cached GitHub state (open, closed, merged) of a linked issue or pull
 * request. Stale or unavailable status reads "unknown". Renders nothing while
 * the sync is off, so a server that never calls GitHub shows no badges.
 */
export default function RemoteStatusBadge({ status }: { status: Schemas["RemoteStatus"] | undefined }) {
  const enabled = useSyncEnabled();
  if (!enabled) return null;
  const { state, hint } = remoteDisplay(status, formatTime);
  return (
    <span className="badge remote" data-remote={state} title={hint} aria-label={`GitHub status: ${state}`}>
      {state}
    </span>
  );
}
