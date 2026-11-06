import { hasFilters, type Epic, type Filters } from "../lib/board";

interface Props {
  filters: Filters;
  epics: readonly Epic[];
  assignees: readonly string[];
  tags: readonly string[];
  onChange: (next: Filters) => void;
}

export default function FilterBar({ filters, epics, assignees, tags, onChange }: Props) {
  return (
    <form className="filters" onSubmit={(e) => e.preventDefault()} aria-label="Story filters">
      <label>
        Epic
        <select
          value={filters.epic ?? ""}
          onChange={(e) =>
            onChange({ ...filters, epic: e.target.value === "" ? null : Number(e.target.value) })
          }
        >
          <option value="">All epics</option>
          {epics.map((epic) => (
            <option key={epic.id} value={epic.id}>
              {epic.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Assignee
        <select
          value={filters.assignee}
          onChange={(e) => onChange({ ...filters, assignee: e.target.value })}
        >
          <option value="">Anyone</option>
          {assignees.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      <label>
        Tag
        <select value={filters.tag} onChange={(e) => onChange({ ...filters, tag: e.target.value })}>
          <option value="">Any tag</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      {hasFilters(filters) && (
        <button type="button" onClick={() => onChange({ epic: null, assignee: "", tag: "" })}>
          Clear filters
        </button>
      )}
    </form>
  );
}
