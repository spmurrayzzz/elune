package main

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func testApp(t *testing.T) *app {
	t.Helper()
	return &app{store: &Store{path: filepath.Join(t.TempDir(), "store.json"), traces: []Trace{}}}
}

func testTrace() Trace {
	root := "agent-1"
	return Trace{
		ID: "pi-trace-1", Source: "pi", Status: "running", Revision: 1,
		Name: "Inspect workspace", Timestamp: "2026-09-28T16:00:00.000Z", Environment: "local",
		SessionID: "pi-session-1", Level: "DEFAULT", Input: "Read the project files", Model: "test-model",
		Tags: []string{"pi"}, Observations: []Observation{
			{ID: root, Name: "Pi agent", Type: "AGENT", Status: "running", Level: "DEFAULT"},
			{ID: "generation-1", ParentID: &root, Name: "Model call", Type: "GENERATION", Status: "running", Level: "DEFAULT", Model: "test-model"},
		},
	}
}

func ingestRequest(t *testing.T, a *app, trace Trace) *httptest.ResponseRecorder {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"trace": trace})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	a.ingest(response, httptest.NewRequest(http.MethodPost, "/api/ingest", bytes.NewReader(payload)))
	return response
}

func decodeTrace(t *testing.T, response *httptest.ResponseRecorder) Trace {
	t.Helper()
	var trace Trace
	if err := json.Unmarshal(response.Body.Bytes(), &trace); err != nil {
		t.Fatal(err)
	}
	return trace
}

func annotationRequest(a *app, method, path, body string, handler http.HandlerFunc) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.SetPathValue("id", "pi-trace-1")
	response := httptest.NewRecorder()
	handler(response, request)
	return response
}

func TestIngestSnapshotsPersistAndPreserveAnnotations(t *testing.T) {
	a := testApp(t)
	trace := testTrace()
	trace.Bookmarked = true
	trace.Scores = []Score{{ID: "untrusted", Name: "injected"}}
	response := ingestRequest(t, a, trace)
	if response.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", response.Code, response.Body.String())
	}
	created := decodeTrace(t, response)
	if created.Bookmarked || len(created.Scores) != 0 {
		t.Fatal("ingestion accepted annotations")
	}
	response = annotationRequest(a, http.MethodPatch, "/api/traces/pi-trace-1", `{"bookmarked":true}`, a.bookmark)
	if response.Code != http.StatusOK {
		t.Fatalf("bookmark: %s", response.Body.String())
	}
	response = annotationRequest(a, http.MethodPost, "/api/traces/pi-trace-1/scores", `{"name":"correctness","value":1,"comment":"verified"}`, a.addScore)
	if response.Code != http.StatusCreated {
		t.Fatalf("score: %s", response.Body.String())
	}
	trace.Revision = 3
	trace.Status = "completed"
	trace.Output = "Project inspected"
	trace.Bookmarked = false
	trace.Scores = nil
	response = ingestRequest(t, a, trace)
	if response.Code != http.StatusOK {
		t.Fatalf("update: %d %s", response.Code, response.Body.String())
	}
	updated := decodeTrace(t, response)
	if updated.Revision != 3 || updated.Status != "completed" || !updated.Bookmarked || len(updated.Scores) != 1 || updated.Scores[0].Source != "ANNOTATION" {
		t.Fatalf("update lost trace state or annotations: %+v", updated)
	}
	for _, revision := range []uint64{1, 2, 3} {
		trace.Revision = revision
		trace.Output = "stale output"
		response = ingestRequest(t, a, trace)
		replayed := decodeTrace(t, response)
		if response.Code != http.StatusOK || replayed.Revision != 3 || replayed.Output != "Project inspected" || !replayed.Bookmarked || len(replayed.Scores) != 1 {
			t.Fatalf("revision %d replay replaced current state: %s", revision, response.Body.String())
		}
	}
	reopened, err := openStore(a.store.path)
	if err != nil {
		t.Fatal(err)
	}
	if len(reopened.traces) != 1 || reopened.traces[0].Revision != 3 || !reopened.traces[0].Bookmarked || len(reopened.traces[0].Scores) != 1 {
		t.Fatalf("incorrect persisted state: %+v", reopened.traces)
	}
}

func TestIngestRejectsInvalidSnapshots(t *testing.T) {
	cases := map[string]func(*Trace){
		"invalid id":       func(trace *Trace) { trace.ID = "../trace" },
		"missing session":  func(trace *Trace) { trace.SessionID = "" },
		"wrong source":     func(trace *Trace) { trace.Source = "other" },
		"zero revision":    func(trace *Trace) { trace.Revision = 0 },
		"invalid status":   func(trace *Trace) { trace.Status = "done" },
		"invalid time":     func(trace *Trace) { trace.Timestamp = "yesterday" },
		"empty name":       func(trace *Trace) { trace.Name = " " },
		"large input":      func(trace *Trace) { trace.Input = strings.Repeat("a", (1<<20)+1) },
		"negative latency": func(trace *Trace) { trace.Latency = -1 },
		"negative tokens":  func(trace *Trace) { trace.TotalTokens = -1 },
		"negative cost":    func(trace *Trace) { trace.Cost = -1 },
		"invalid level":    func(trace *Trace) { trace.Level = "GOOD" },
		"duplicate id":     func(trace *Trace) { trace.Observations[1].ID = trace.Observations[0].ID },
		"invalid type":     func(trace *Trace) { trace.Observations[1].Type = "OTHER" },
		"invalid child":    func(trace *Trace) { trace.Observations[1].Status = "done" },
		"negative offset":  func(trace *Trace) { trace.Observations[1].StartTime = -1 },
		"negative duration": func(trace *Trace) {
			trace.Observations[1].Duration = -1
		},
		"missing parent": func(trace *Trace) {
			parent := "absent"
			trace.Observations[1].ParentID = &parent
		},
		"self cycle": func(trace *Trace) {
			trace.Observations[0].ParentID = &trace.Observations[0].ID
		},
		"cycle": func(trace *Trace) {
			trace.Observations[0].ParentID = &trace.Observations[1].ID
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			a := testApp(t)
			trace := testTrace()
			mutate(&trace)
			response := ingestRequest(t, a, trace)
			if response.Code != http.StatusBadRequest || len(a.store.traces) != 0 {
				t.Fatalf("accepted invalid trace: %d %s", response.Code, response.Body.String())
			}
		})
	}
	for _, value := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		trace := testTrace()
		trace.Latency = value
		if validateTrace(trace) == nil {
			t.Fatalf("accepted nonfinite latency %v", value)
		}
	}
}

func TestIngestRejectsInvalidJSONAndLargeRequests(t *testing.T) {
	a := testApp(t)
	for _, body := range []string{`{`, `{}`, `{"trace":{}} {}`, `{"trace":{},"other":true}`, `{"trace":{"revision":-1}}`, `{"trace":{"metadata":{"large":"` + strings.Repeat("a", 8<<20) + `"}}}`} {
		response := httptest.NewRecorder()
		a.ingest(response, httptest.NewRequest(http.MethodPost, "/api/ingest", strings.NewReader(body)))
		if response.Code != http.StatusBadRequest || len(a.store.traces) != 0 {
			t.Fatalf("accepted invalid body: status %d", response.Code)
		}
	}
}

func TestIngestProtectsTraceIdentityAndOtherSources(t *testing.T) {
	a := testApp(t)
	trace := testTrace()
	other := trace
	other.Source = ""
	a.store.traces = []Trace{other}
	if response := ingestRequest(t, a, trace); response.Code != http.StatusConflict {
		t.Fatalf("overwrote other source: %d", response.Code)
	}
	a.store.traces = []Trace{trace}
	for _, field := range []string{"session", "timestamp"} {
		updated := testTrace()
		updated.Revision = 2
		if field == "session" {
			updated.SessionID = "another-session"
		} else {
			updated.Timestamp = time.Now().UTC().Format(time.RFC3339Nano)
		}
		if response := ingestRequest(t, a, updated); response.Code != http.StatusConflict {
			t.Fatalf("changed %s: %d", field, response.Code)
		}
	}
}

func TestIngestPersistenceFailureDoesNotPublish(t *testing.T) {
	a := testApp(t)
	if err := os.Mkdir(a.store.path, 0700); err != nil {
		t.Fatal(err)
	}
	subscriber := make(chan traceNotice, 1)
	a.subscribers = map[chan traceNotice]struct{}{subscriber: {}}
	response := ingestRequest(t, a, testTrace())
	if response.Code != http.StatusInternalServerError || len(a.store.traces) != 0 || len(subscriber) != 0 {
		t.Fatalf("published failed persistence: %d %s", response.Code, response.Body.String())
	}
}

func TestConcurrentSnapshotsKeepHighestRevision(t *testing.T) {
	a := testApp(t)
	var pending sync.WaitGroup
	for revision := uint64(1); revision <= 24; revision++ {
		pending.Add(1)
		go func() {
			defer pending.Done()
			trace := testTrace()
			trace.Revision = revision
			response := ingestRequest(t, a, trace)
			if response.Code != http.StatusOK && response.Code != http.StatusCreated {
				t.Errorf("ingest revision %d: %d", revision, response.Code)
			}
		}()
	}
	pending.Wait()
	reopened, err := openStore(a.store.path)
	if err != nil {
		t.Fatal(err)
	}
	if len(reopened.traces) != 1 || reopened.traces[0].Revision != 24 {
		t.Fatalf("incorrect concurrent state: %+v", reopened.traces)
	}
}

func TestOverviewUsesGenerationModelsForPi(t *testing.T) {
	a := testApp(t)
	trace := testTrace()
	trace.TotalTokens, trace.Cost = 30, 0.03
	trace.Observations[1].InputTokens, trace.Observations[1].OutputTokens, trace.Observations[1].Cost = 9, 1, 0.01
	trace.Observations = append(trace.Observations, Observation{ID: "generation-2", Type: "GENERATION", Model: "second-model", InputTokens: 18, OutputTokens: 2, Cost: 0.02})
	demo := Trace{ID: "demo", Model: "demo-model", TotalTokens: 40, Cost: 0.04}
	a.store.traces = []Trace{trace, demo}
	response := httptest.NewRecorder()
	a.overview(response, httptest.NewRequest(http.MethodGet, "/api/overview", nil))
	var result struct {
		TotalTokens int            `json:"totalTokens"`
		TotalCost   float64        `json:"totalCost"`
		Models      []modelSummary `json:"models"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.TotalTokens != 70 || result.TotalCost != 0.07 || len(result.Models) != 3 || result.Models[0].Name != "demo-model" || result.Models[1].Name != "second-model" || result.Models[2].Tokens != 10 {
		t.Fatalf("incorrect model usage: %+v", result)
	}
}

func TestOverviewCountsSampleModelCalls(t *testing.T) {
	a := testApp(t)
	a.store.traces = []Trace{{
		ID: "sample", Model: "planning-model", TotalTokens: 60, Cost: 0.06,
		Observations: []Observation{
			{Type: "AGENT", Model: "planning-model", InputTokens: 54, OutputTokens: 6, Cost: 0.06},
			{Type: "GENERATION", Model: "planning-model", InputTokens: 9, OutputTokens: 1, Cost: 0.01},
			{Type: "GENERATION", Model: "answer-model", InputTokens: 18, OutputTokens: 2, Cost: 0.02},
			{Type: "GENERATION", Model: "answer-model", InputTokens: 27, OutputTokens: 3, Cost: 0.03},
		},
	}}
	response := httptest.NewRecorder()
	a.overview(response, httptest.NewRequest(http.MethodGet, "/api/overview", nil))
	var result struct {
		Models []modelSummary `json:"models"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Models) != 2 || result.Models[0] != (modelSummary{Name: "answer-model", Count: 2, Tokens: 50, Cost: 0.05}) || result.Models[1] != (modelSummary{Name: "planning-model", Count: 1, Tokens: 10, Cost: 0.01}) {
		t.Fatalf("incorrect sample model calls: %+v", result.Models)
	}
}
