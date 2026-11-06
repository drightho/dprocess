/** A coloured label for an epic or story state. The text carries the meaning; colour is a hint. */
export default function StateBadge({ state }: { state: string }) {
  return (
    <span className="badge state" data-state={state}>
      {state}
    </span>
  );
}
