package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"log"
	"math"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

func storeError(w http.ResponseWriter, operation string, err error) {
	log.Printf("%s: %v", operation, err)
	writeError(w, http.StatusInternalServerError, "Could not access stored data")
}

func (a *app) trace(w http.ResponseWriter, r *http.Request) {
	tx, err := a.store.db.BeginTx(r.Context(), nil)
	if err != nil {
		storeError(w, "Read trace", err)
		return
	}
	defer tx.Rollback()
	trace, err := getTrace(r.Context(), tx, r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Trace not found")
		return
	}
	if err != nil {
		storeError(w, "Read trace", err)
		return
	}
	writeJSON(w, http.StatusOK, trace)
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
	tx, err := a.store.writer.BeginTx(r.Context(), nil)
	if err != nil {
		storeError(w, "Save bookmark", err)
		return
	}
	defer tx.Rollback()
	trace, err := getTrace(r.Context(), tx, r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Trace not found")
		return
	}
	if err != nil {
		storeError(w, "Read trace", err)
		return
	}
	trace.Bookmarked = *body.Bookmarked
	if _, err := tx.ExecContext(r.Context(), "UPDATE traces SET bookmarked=? WHERE id=?", trace.Bookmarked, trace.ID); err != nil {
		storeError(w, "Save bookmark", err)
		return
	}
	if err := tx.Commit(); err != nil {
		storeError(w, "Save bookmark", err)
		return
	}
	a.broadcast(trace)
	writeJSON(w, http.StatusOK, trace)
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
	tx, err := a.store.writer.BeginTx(r.Context(), nil)
	if err != nil {
		storeError(w, "Save score", err)
		return
	}
	defer tx.Rollback()
	trace, err := getTrace(r.Context(), tx, r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Trace not found")
		return
	}
	if err != nil {
		storeError(w, "Read trace", err)
		return
	}
	score := Score{ID: "score-" + hex.EncodeToString(idBytes), TraceID: trace.ID, TraceName: trace.Name,
		Name: body.Name, Value: *body.Value, Comment: body.Comment, Source: "ANNOTATION",
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano), DataType: "NUMERIC"}
	if err := insertScore(r.Context(), tx, score); err != nil {
		storeError(w, "Save score", err)
		return
	}
	if err := tx.Commit(); err != nil {
		storeError(w, "Save score", err)
		return
	}
	a.broadcast(trace)
	writeJSON(w, http.StatusCreated, score)
}
