import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";
import { readAuthor, saveAuthor } from "../lib/author";
import { formatTime } from "../lib/format";

interface Props {
  kind: "epic" | "story";
  id: number;
}

/**
 * The comments of an epic or story, oldest first, and a form to add one.
 * Comments are never edited or deleted. They stay open on finished and
 * cancelled stories. The author name is remembered in the browser; the
 * server validates the comment and its message is shown inside the form.
 */
export default function CommentThread({ kind, id }: Props) {
  const queryClient = useQueryClient();
  const queryKey = [kind, id, "comments"];
  const [author, setAuthor] = useState(() => readAuthor());
  const [body, setBody] = useState("");

  const comments = useQuery({
    queryKey,
    queryFn: () =>
      kind === "epic"
        ? unwrap(api.GET("/epics/{id}/comments", { params: { path: { id } } }))
        : unwrap(api.GET("/stories/{id}/comments", { params: { path: { id } } })),
  });

  const post = useMutation({
    mutationFn: () =>
      kind === "epic"
        ? unwrap(api.POST("/epics/{id}/comments", { params: { path: { id } }, body: { body, author } }))
        : unwrap(api.POST("/stories/{id}/comments", { params: { path: { id } }, body: { body, author } })),
    onSuccess: async () => {
      saveAuthor(author.trim());
      setBody("");
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    post.mutate();
  }

  return (
    <section aria-label="Comments">
      {comments.isError ? (
        <p role="alert" className="error">
          Could not load the comments: {comments.error.message}
        </p>
      ) : !comments.data ? (
        <p>Loading...</p>
      ) : comments.data.length === 0 ? (
        <p className="empty">No comments yet.</p>
      ) : (
        <ol className="comments" aria-label="Comment thread">
          {comments.data.map((c) => (
            <li key={c.id}>
              <span className="meta">
                {c.author || "anonymous"} &middot; {formatTime(c.created_at)}
              </span>
              <p>{c.body}</p>
            </li>
          ))}
        </ol>
      )}
      {/* Typing dismisses the server's last complaint: it was about what was submitted, not what is typed now. */}
      <form onSubmit={submit} onChange={() => post.isError && post.reset()} aria-label="Add comment">
        <label>
          Author
          <input value={author} onChange={(e) => setAuthor(e.target.value)} />
        </label>
        <label>
          Comment
          <textarea value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        {post.isError && (
          <p role="alert" className="error">
            {post.error.message}
          </p>
        )}
        <div className="actions">
          <button type="submit" disabled={post.isPending}>
            Add comment
          </button>
        </div>
      </form>
    </section>
  );
}
