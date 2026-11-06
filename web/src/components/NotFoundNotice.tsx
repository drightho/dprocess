import { Link } from "react-router-dom";

/** Shown when a project or epic does not exist (or its id in the URL is malformed). */
export default function NotFoundNotice({ what }: { what: string }) {
  return (
    <section className="narrow">
      <h1>{what} not found</h1>
      <p>
        <Link to="/">Back to projects</Link>
      </p>
    </section>
  );
}
