import { Link, Route, Routes } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "./api/client";
import LandingPage from "./pages/LandingPage";
import ProjectPage from "./pages/ProjectPage";
import ProjectsPage from "./pages/ProjectsPage";

function HealthBadge() {
  const { isSuccess, isError } = useQuery({
    queryKey: ["health"],
    queryFn: () => unwrap(api.GET("/health")),
    refetchInterval: 30_000,
  });
  const label = isSuccess ? "API ok" : isError ? "API unreachable" : "API ...";
  return <span className={`badge ${isError ? "bad" : ""}`}>{label}</span>;
}

function NotFound() {
  return (
    <section className="narrow">
      <h2>Page not found</h2>
      <p>
        <Link to="/">Back to projects</Link>
      </p>
    </section>
  );
}

export default function App() {
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          DProcess
        </Link>
        <HealthBadge />
      </header>
      <main>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </>
  );
}
