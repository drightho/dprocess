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
	"github.com/dright/dprocess/internal/github"
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
	ghSync := flag.Bool("github-sync", getenv("DPROCESS_GITHUB_SYNC", "") == "1", "periodically read the status of linked GitHub issues and pull requests (read-only; token from DPROCESS_GITHUB_TOKEN)")
	ghEvery := flag.Duration("github-sync-interval", 15*time.Minute, "time between GitHub status refreshes")
	flag.Parse()

	st, err := store.Open(*dbPath)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer st.Close()

	apiSrv := &api.Server{Store: st, UI: web.FS()}
	if *ghSync {
		apiSrv.GitHub = &github.Syncer{
			Store:    st,
			Client:   &github.Client{BaseURL: getenv("DPROCESS_GITHUB_API", github.DefaultAPI), Token: os.Getenv("DPROCESS_GITHUB_TOKEN")},
			Interval: *ghEvery,
		}
	}
	srv := &http.Server{
		Addr:              *addr,
		Handler:           apiSrv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if apiSrv.GitHub != nil {
		go apiSrv.GitHub.Run(ctx)
		log.Printf("github status sync enabled (every %s, token set: %t)", *ghEvery, os.Getenv("DPROCESS_GITHUB_TOKEN") != "")
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
