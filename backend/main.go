package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
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
		dataPath = filepath.Join("data", "store.json")
	}
	store, err := openStore(dataPath)
	if err != nil {
		log.Fatalf("Open data store: %v", err)
	}
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
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("Server shutdown: %v", err)
		}
	}()
	log.Printf("elune listening at http://%s with %d traces", server.Addr, len(store.traces))
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
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

func (a *app) traces(w http.ResponseWriter, r *http.Request) {
	a.store.mu.RLock()
	defer a.store.mu.RUnlock()
	traces := append([]Trace{}, a.store.traces...)
	sort.SliceStable(traces, func(i, j int) bool {
		left, _ := time.Parse(time.RFC3339Nano, traces[i].Timestamp)
		right, _ := time.Parse(time.RFC3339Nano, traces[j].Timestamp)
		return left.After(right)
	})
	writeJSON(w, http.StatusOK, map[string]any{"data": traces})
}

func (a *app) trace(w http.ResponseWriter, r *http.Request) {
	a.store.mu.RLock()
	defer a.store.mu.RUnlock()
	i := a.store.find(r.PathValue("id"))
	if i < 0 {
		writeError(w, http.StatusNotFound, "Trace not found")
		return
	}
	writeJSON(w, http.StatusOK, a.store.traces[i])
}

func (a *app) bookmark(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Bookmarked *bool `json:"bookmarked"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Bookmarked == nil {
		writeError(w, http.StatusBadRequest, "bookmarked is required and must be a boolean")
		return
	}
	a.store.mu.Lock()
	defer a.store.mu.Unlock()
	i := a.store.find(r.PathValue("id"))
	if i < 0 {
		writeError(w, http.StatusNotFound, "Trace not found")
		return
	}
	updated := append([]Trace{}, a.store.traces...)
	updated[i].Bookmarked = *body.Bookmarked
	if err := a.store.persist(updated); err != nil {
		log.Printf("Save bookmark: %v", err)
		writeError(w, http.StatusInternalServerError, "Could not save bookmark")
		return
	}
	a.store.traces = updated
	a.broadcast(updated[i])
	writeJSON(w, http.StatusOK, updated[i])
}

func (a *app) addScore(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name    string   `json:"name"`
		Value   *float64 `json:"value"`
		Comment string   `json:"comment"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	body.Comment = strings.TrimSpace(body.Comment)
	if body.Name == "" || utf8.RuneCountInString(body.Name) > 80 {
		writeError(w, http.StatusBadRequest, "Score name must contain between 1 and 80 characters")
		return
	}
	if body.Value == nil || math.IsInf(*body.Value, 0) || math.IsNaN(*body.Value) {
		writeError(w, http.StatusBadRequest, "Score value must be a finite number")
		return
	}
	if utf8.RuneCountInString(body.Comment) > 4000 {
		writeError(w, http.StatusBadRequest, "Score comment must not exceed 4000 characters")
		return
	}
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create score identifier")
		return
	}
	a.store.mu.Lock()
	defer a.store.mu.Unlock()
	i := a.store.find(r.PathValue("id"))
	if i < 0 {
		writeError(w, http.StatusNotFound, "Trace not found")
		return
	}
	score := Score{
		ID: "score-" + hex.EncodeToString(idBytes), TraceID: a.store.traces[i].ID, TraceName: a.store.traces[i].Name,
		Name: body.Name, Value: *body.Value, Comment: body.Comment, Source: "ANNOTATION",
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano), DataType: "NUMERIC",
	}
	updated := append([]Trace{}, a.store.traces...)
	updated[i].Scores = append(append([]Score{}, updated[i].Scores...), score)
	if err := a.store.persist(updated); err != nil {
		log.Printf("Save score: %v", err)
		writeError(w, http.StatusInternalServerError, "Could not save score")
		return
	}
	a.store.traces = updated
	a.broadcast(updated[i])
	writeJSON(w, http.StatusCreated, score)
}

func (a *app) sessions(w http.ResponseWriter, r *http.Request) {
	a.store.mu.RLock()
	defer a.store.mu.RUnlock()
	byID := map[string]*Session{}
	for _, trace := range a.store.traces {
		session, exists := byID[trace.SessionID]
		if !exists {
			session = &Session{ID: trace.SessionID, UserID: trace.UserID, StartTime: trace.Timestamp, EndTime: trace.Timestamp, Environment: trace.Environment, TraceIDs: []string{}}
			byID[trace.SessionID] = session
		}
		start, err := time.Parse(time.RFC3339Nano, trace.Timestamp)
		endTime := trace.Timestamp
		if err == nil {
			endTime = start.Add(time.Duration(trace.Latency * float64(time.Second))).Format(time.RFC3339Nano)
		}
		if trace.Timestamp < session.StartTime {
			session.StartTime = trace.Timestamp
		}
		if endTime > session.EndTime {
			session.EndTime = endTime
		}
		session.TraceCount++
		session.TotalTokens += trace.TotalTokens
		session.Cost += trace.Cost
		session.Latency += trace.Latency
		session.TraceIDs = append(session.TraceIDs, trace.ID)
	}
	sessions := make([]Session, 0, len(byID))
	for _, session := range byID {
		session.Cost = round(session.Cost, 8)
		session.Latency = round(session.Latency, 3)
		sessions = append(sessions, *session)
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].StartTime > sessions[j].StartTime })
	writeJSON(w, http.StatusOK, map[string]any{"data": sessions})
}

func (a *app) scores(w http.ResponseWriter, r *http.Request) {
	a.store.mu.RLock()
	defer a.store.mu.RUnlock()
	scores := []Score{}
	for _, trace := range a.store.traces {
		scores = append(scores, trace.Scores...)
	}
	sort.Slice(scores, func(i, j int) bool { return scores[i].Timestamp > scores[j].Timestamp })
	writeJSON(w, http.StatusOK, map[string]any{"data": scores})
}

type seriesPoint struct {
	Date    string  `json:"date"`
	Count   int     `json:"count"`
	Tokens  int     `json:"tokens"`
	Cost    float64 `json:"cost"`
	Latency float64 `json:"latency"`
}

type modelSummary struct {
	Name   string  `json:"name"`
	Tokens int     `json:"tokens"`
	Cost   float64 `json:"cost"`
	Count  int     `json:"count"`
}

type nameSummary struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

func (a *app) overview(w http.ResponseWriter, r *http.Request) {
	a.store.mu.RLock()
	defer a.store.mu.RUnlock()
	totalTokens, errorCount, scoreCount := 0, 0, 0
	var totalCost, totalLatency, scoreSum float64
	days := map[string]*seriesPoint{}
	now := time.Now().UTC()
	for offset := 6; offset >= 0; offset-- {
		date := now.AddDate(0, 0, -offset).Format(time.DateOnly)
		days[date] = &seriesPoint{Date: date}
	}
	modelMap := map[string]*modelSummary{}
	nameMap := map[string]int{}
	for _, trace := range a.store.traces {
		totalTokens += trace.TotalTokens
		totalCost += trace.Cost
		totalLatency += trace.Latency
		if trace.Level == "ERROR" {
			errorCount++
		}
		for _, score := range trace.Scores {
			scoreSum += score.Value
			scoreCount++
		}
		date := strings.SplitN(trace.Timestamp, "T", 2)[0]
		if point, ok := days[date]; ok {
			point.Count++
			point.Tokens += trace.TotalTokens
			point.Cost += trace.Cost
			point.Latency += trace.Latency
		}
		if len(trace.Observations) > 0 {
			for _, observation := range trace.Observations {
				if observation.Type != "GENERATION" {
					continue
				}
				if _, ok := modelMap[observation.Model]; !ok {
					modelMap[observation.Model] = &modelSummary{Name: observation.Model}
				}
				modelMap[observation.Model].Tokens += observation.InputTokens + observation.OutputTokens
				modelMap[observation.Model].Cost += observation.Cost
				modelMap[observation.Model].Count++
			}
		} else if trace.Source != "pi" {
			if _, ok := modelMap[trace.Model]; !ok {
				modelMap[trace.Model] = &modelSummary{Name: trace.Model}
			}
			modelMap[trace.Model].Tokens += trace.TotalTokens
			modelMap[trace.Model].Cost += trace.Cost
			modelMap[trace.Model].Count++
		}
		nameMap[trace.Name]++
	}
	series := make([]seriesPoint, 0, len(days))
	for _, point := range days {
		if point.Count > 0 {
			point.Latency = round(point.Latency/float64(point.Count), 3)
		}
		point.Cost = round(point.Cost, 8)
		series = append(series, *point)
	}
	sort.Slice(series, func(i, j int) bool { return series[i].Date < series[j].Date })
	models := make([]modelSummary, 0, len(modelMap))
	for _, model := range modelMap {
		model.Cost = round(model.Cost, 8)
		models = append(models, *model)
	}
	sort.Slice(models, func(i, j int) bool { return models[i].Tokens > models[j].Tokens })
	names := make([]nameSummary, 0, len(nameMap))
	for name, count := range nameMap {
		names = append(names, nameSummary{Name: name, Count: count})
	}
	sort.Slice(names, func(i, j int) bool {
		if names[i].Count == names[j].Count {
			return names[i].Name < names[j].Name
		}
		return names[i].Count > names[j].Count
	})
	avgLatency, errorRate, scoreAverage := 0.0, 0.0, 0.0
	if len(a.store.traces) > 0 {
		avgLatency = round(totalLatency/float64(len(a.store.traces)), 3)
		errorRate = round(float64(errorCount)/float64(len(a.store.traces))*100, 2)
	}
	if scoreCount > 0 {
		scoreAverage = round(scoreSum/float64(scoreCount), 4)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"totalTraces": len(a.store.traces), "totalTokens": totalTokens, "totalCost": round(totalCost, 8),
		"avgLatency": avgLatency, "errorRate": errorRate, "series": series, "models": models,
		"names": names, "scoreAverage": scoreAverage,
	})
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
