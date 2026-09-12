package main

import (
	"fmt"
	"log"
	"math"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

func (a *app) ingest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Trace Trace `json:"trace"`
	}
	if !readLimitedJSON(w, r, &body, 8<<20) {
		return
	}
	trace := body.Trace
	if err := validateTrace(trace); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	a.store.mu.Lock()
	defer a.store.mu.Unlock()
	i := a.store.find(trace.ID)
	status := http.StatusCreated
	trace.Bookmarked = false
	trace.Scores = []Score{}
	if i >= 0 {
		current := a.store.traces[i]
		if current.Source != "pi" {
			writeError(w, http.StatusConflict, "Trace identifier already belongs to another source")
			return
		}
		if trace.Revision <= current.Revision {
			writeJSON(w, http.StatusOK, current)
			return
		}
		if trace.SessionID != current.SessionID || trace.Timestamp != current.Timestamp {
			writeError(w, http.StatusConflict, "Trace session and timestamp cannot change")
			return
		}
		trace.Bookmarked = current.Bookmarked
		trace.Scores = current.Scores
		status = http.StatusOK
	}
	if trace.Tags == nil {
		trace.Tags = []string{}
	}
	if trace.Observations == nil {
		trace.Observations = []Observation{}
	}
	updated := append([]Trace{}, a.store.traces...)
	if i < 0 {
		updated = append(updated, trace)
	} else {
		updated[i] = trace
	}
	if err := a.store.persist(updated); err != nil {
		log.Printf("Save trace: %v", err)
		writeError(w, http.StatusInternalServerError, "Could not save trace")
		return
	}
	a.store.traces = updated
	a.broadcast(trace)
	writeJSON(w, status, trace)
}

func validateTrace(trace Trace) error {
	if !validID(trace.ID) || !validID(trace.SessionID) {
		return fmt.Errorf("Trace and session identifiers must contain 1 to 160 letters, digits, periods, colons, underscores, or hyphens")
	}
	if trace.Source != "pi" || trace.Revision == 0 || !validStatus(trace.Status) {
		return fmt.Errorf("Trace requires source pi, a positive revision, and status running, completed, error, or aborted")
	}
	if _, err := time.Parse(time.RFC3339Nano, trace.Timestamp); err != nil {
		return fmt.Errorf("Trace timestamp must use RFC3339 format")
	}
	if strings.TrimSpace(trace.Name) == "" || !validText(trace.Name, 512) || !validText(trace.Environment, 160) || !validText(trace.UserID, 512) || !validText(trace.Model, 512) || !validText(trace.Version, 160) {
		return fmt.Errorf("Trace name is required and trace labels must fit their size limits")
	}
	if !validText(trace.Input, 1<<20) || !validText(trace.Output, 1<<20) || len(trace.Tags) > 64 || len(trace.Observations) > 4096 {
		return fmt.Errorf("Trace input, output, tags, or observation count exceeds its size limit")
	}
	for _, tag := range trace.Tags {
		if !validText(tag, 160) {
			return fmt.Errorf("Trace tags must not exceed 160 bytes")
		}
	}
	if !validNumber(trace.Latency, 365*24*60*60) || !validNumber(trace.Cost, 1e9) || !validTokens(trace.TotalTokens, trace.InputTokens, trace.OutputTokens) {
		return fmt.Errorf("Trace timing, token counts, and cost must be finite nonnegative numbers within their limits")
	}
	if !validLevel(trace.Level) {
		return fmt.Errorf("Trace level must be DEBUG, DEFAULT, WARNING, or ERROR")
	}
	parents := make(map[string]string, len(trace.Observations))
	for _, observation := range trace.Observations {
		if !validID(observation.ID) {
			return fmt.Errorf("Observation identifier is invalid")
		}
		if _, exists := parents[observation.ID]; exists {
			return fmt.Errorf("Observation identifiers must be unique within a trace")
		}
		parent := ""
		if observation.ParentID != nil {
			parent = *observation.ParentID
			if !validID(parent) {
				return fmt.Errorf("Observation parent identifier is invalid")
			}
		}
		parents[observation.ID] = parent
		if strings.TrimSpace(observation.Name) == "" || !validText(observation.Name, 512) || !validText(observation.Model, 512) || !validText(observation.Input, 1<<20) || !validText(observation.Output, 1<<20) {
			return fmt.Errorf("Observation name is required and observation text must fit its size limits")
		}
		switch observation.Type {
		case "AGENT", "SPAN", "GENERATION", "TOOL", "EVENT", "RETRIEVER", "EMBEDDING", "EVALUATOR", "GUARDRAIL", "CHAIN":
		default:
			return fmt.Errorf("Observation type is invalid")
		}
		if (observation.Status != "" && !validStatus(observation.Status)) || !validLevel(observation.Level) {
			return fmt.Errorf("Observation status or level is invalid")
		}
		if !validNumber(observation.StartTime, 365*24*60*60) || !validNumber(observation.Duration, 365*24*60*60) || !validNumber(observation.Cost, 1e9) || !validTokens(observation.InputTokens, observation.OutputTokens) {
			return fmt.Errorf("Observation timing, token counts, and cost must be finite nonnegative numbers within their limits")
		}
	}
	visited := make(map[string]bool, len(parents))
	for id := range parents {
		path := map[string]bool{}
		for current := id; current != "" && !visited[current]; current = parents[current] {
			if path[current] {
				return fmt.Errorf("Observation parents must not form a cycle")
			}
			if _, exists := parents[current]; !exists {
				return fmt.Errorf("Observation parent must belong to the same trace")
			}
			path[current] = true
		}
		for current := range path {
			visited[current] = true
		}
	}
	return nil
}

func validID(value string) bool {
	if len(value) == 0 || len(value) > 160 {
		return false
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == '.' || c == ':') {
			return false
		}
	}
	return true
}

func validStatus(value string) bool {
	return value == "running" || value == "completed" || value == "error" || value == "aborted"
}

func validLevel(value string) bool {
	return value == "DEBUG" || value == "DEFAULT" || value == "WARNING" || value == "ERROR"
}

func validText(value string, limit int) bool {
	return len(value) <= limit && utf8.ValidString(value)
}

func validNumber(value, limit float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= limit
}

func validTokens(values ...int) bool {
	for _, value := range values {
		if value < 0 || value > 1e12 {
			return false
		}
	}
	return true
}
