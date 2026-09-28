package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type app struct {
	store       *Store
	eventsMu    sync.Mutex
	subscribers map[chan traceNotice]struct{}
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		log.Fatal("PORT must be a number between 1 and 65535")
	}
	dataPath := os.Getenv("DATA_PATH")
	if dataPath == "" {
		dataPath = filepath.Join("data", "elune.db")
	}
	store, err := openStore(dataPath)
	if err != nil {
		log.Fatalf("Open data store: %v", err)
	}
	defer store.Close()
	a := &app{store: store}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "elune"})
	})
	mux.HandleFunc("POST /api/ingest", a.ingest)
	mux.HandleFunc("GET /api/events", a.events)
	mux.HandleFunc("GET /api/traces", a.traces)
	mux.HandleFunc("GET /api/traces/{id}", a.trace)
	mux.HandleFunc("PATCH /api/traces/{id}", a.bookmark)
	mux.HandleFunc("POST /api/traces/{id}/scores", a.addScore)
	mux.HandleFunc("GET /api/sessions", a.sessions)
	mux.HandleFunc("GET /api/sessions/{id}", a.session)
	mux.HandleFunc("GET /api/filters", a.filters)
	mux.HandleFunc("GET /api/scores", a.scores)
	mux.HandleFunc("GET /api/overview", a.overview)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "API endpoint not found")
	})
	dist := os.Getenv("FRONTEND_DIST")
	if dist == "" {
		dist = filepath.Join("..", "frontend", "dist")
	}
	mux.HandleFunc("/", serveFrontend(dist))
	server := &http.Server{
		Addr: net.JoinHostPort("127.0.0.1", port), Handler: localRequests(mux),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second,
		WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("Server shutdown: %v", err)
			server.Close()
		}
	}()
	log.Printf("elune listening at http://%s", server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		store.Close()
		log.Fatal(err)
	}
	<-shutdownDone
}

func localRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		host := r.Host
		if hostname, _, err := net.SplitHostPort(host); err == nil {
			host = hostname
		}
		if host == "[::1]" {
			host = "::1"
		}
		if !isLocalHost(strings.ToLower(host)) {
			writeError(w, http.StatusForbidden, "Only local app hosts are allowed")
			return
		}
		origin := r.Header.Get("Origin")
		if origin != "" {
			u, err := url.Parse(origin)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") || !isLocalHost(u.Hostname()) {
				writeError(w, http.StatusForbidden, "Only local app origins are allowed")
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isLocalHost(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func serveFrontend(dist string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
			return
		}
		path := filepath.Join(dist, filepath.FromSlash(strings.TrimPrefix(filepath.Clean("/"+r.URL.Path), string(filepath.Separator))))
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			http.ServeFile(w, r, path)
			return
		}
		if filepath.Ext(r.URL.Path) != "" {
			http.NotFound(w, r)
			return
		}
		index := filepath.Join(dist, "index.html")
		if _, err := os.Stat(index); err != nil {
			writeJSON(w, http.StatusOK, map[string]string{"service": "elune", "message": "API is ready. Start the Vite frontend or build it to serve the app here."})
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, index)
	}
}

func readJSON(w http.ResponseWriter, r *http.Request, dest any) bool {
	return readLimitedJSON(w, r, dest, 1<<20)
}

func readLimitedJSON(w http.ResponseWriter, r *http.Request, dest any, limit int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dest); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid JSON request: "+err.Error())
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, http.StatusBadRequest, "Request body must contain exactly one JSON object")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Print(fmt.Errorf("write response: %w", err))
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
