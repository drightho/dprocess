// Command dprocess runs the DProcess server.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/dright/dprocess/internal/api"
	"github.com/dright/dprocess/internal/store"
	"github.com/dright/dprocess/web"
)

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	dbPath := flag.String("db", getenv("DPROCESS_DB", "./dprocess.db"), "SQLite database file")
	addr := flag.String("addr", getenv("DPROCESS_ADDR", "127.0.0.1:8080"), "listen address")
	ghSync := flag.Bool("github-sync", getenv("DPROCESS_GITHUB_SYNC", "") == "1", "periodically import the open, unassigned GitHub issues of linked projects and refresh the status of linked GitHub issues and pull requests (read-only; token from DPROCESS_GITHUB_TOKEN)")
	ghEvery := flag.Duration("github-sync-interval", 15*time.Minute, "time between GitHub status refreshes")
	flag.Parse()

	st, err := store.Open(*dbPath)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	apiSrv := &api.Server{
		Store:          st,
		UI:             web.FS(),
		GitHubToken:    os.Getenv("DPROCESS_GITHUB_TOKEN"),
		GitHubAPI:      os.Getenv("DPROCESS_GITHUB_API"),
		GitHubInterval: *ghEvery,
		Ctx:            ctx,
	}
	defer apiSrv.Close()
	if *ghSync {
		apiSrv.StartGitHub()
		log.Printf("github status sync enabled (every %s, token set: %t)", *ghEvery, apiSrv.GitHubToken != "")
	}
	srv := &http.Server{
		Addr:              *addr,
		Handler:           apiSrv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutCtx)
	}()

	log.Printf("dprocess listening on %s (db: %s)", *addr, *dbPath)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
