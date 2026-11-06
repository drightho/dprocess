import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Schemas } from "../api/client";
import { findProjectsByName } from "../lib/projectSearch";

type Project = Schemas["Project"];

type Outcome =
  | { kind: "none"; name: string }
  | { kind: "many"; name: string; matches: Project[] }
  | { kind: "error"; message: string };

interface Props {
  /** Fetches the current projects; called on every search so a project created elsewhere is found. */
  loadProjects: () => Promise<Project[]>;
}

/** Opens the project whose name matches what was typed (exact match, any letter case). */
export default function ProjectSearch({ loadProjects }: Props) {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const name = text.trim();
    if (name === "") return;
    setBusy(true);
    setOutcome(null);
    try {
      const matches = findProjectsByName(await loadProjects(), name);
      if (matches.length === 1) navigate(`/projects/${matches[0].id}`);
      else if (matches.length === 0) setOutcome({ kind: "none", name });
      else setOutcome({ kind: "many", name, matches });
    } catch (err) {
      setOutcome({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form className="search" onSubmit={submit} role="search" aria-label="Find a project">
        <label>
          Project name
          <input
            type="search"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setOutcome(null);
            }}
            placeholder="Type a project name"
          />
        </label>
        <button type="submit" disabled={busy}>
          Open
        </button>
      </form>
      {outcome?.kind === "none" && (
        <p role="status" className="empty">
          No project named “{outcome.name}”.
        </p>
      )}
      {outcome?.kind === "many" && (
        <div role="status">
          <p className="empty">Several projects are named “{outcome.name}”. Pick one:</p>
          <ul className="cards">
            {outcome.matches.map((p) => (
              <li key={p.id}>
                <Link to={`/projects/${p.id}`}>
                  <strong>{p.name}</strong>
                </Link>
                <span className="meta"> #{p.id}</span>
                {p.description && <p>{p.description}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {outcome?.kind === "error" && (
        <p role="alert" className="error">
          Could not search: {outcome.message}
        </p>
      )}
    </div>
  );
}
