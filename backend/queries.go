package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type listOptions struct {
	page, size int
	from, to   *int64
	values     url.Values
}

func options(r *http.Request) (listOptions, error) {
	q := r.URL.Query()
	opts := listOptions{values: q}
	if q.Has("page") || q.Has("pageSize") {
		opts.page, opts.size = 1, 50
		for key, target := range map[string]*int{"page": &opts.page, "pageSize": &opts.size} {
			if !q.Has(key) {
				continue
			}
			n, err := strconv.Atoi(q.Get(key))
			if err != nil || n < 1 || n > 1000000000 {
				return opts, fmt.Errorf("%s must be a positive integer", key)
			}
			*target = n
		}
		if opts.size > 200 {
			opts.size = 200
		}
	}
	for key, target := range map[string]**int64{"from": &opts.from, "to": &opts.to} {
		if q.Get(key) == "" {
			continue
		}
		value, err := millis(q.Get(key))
		if err != nil {
			return opts, fmt.Errorf("%s must use RFC3339 format", key)
		}
		*target = &value
	}
	if opts.from != nil && opts.to != nil && *opts.from > *opts.to {
		return opts, fmt.Errorf("from must not be later than to")
	}
	if value := q.Get("source"); value != "" && value != "all" && value != "pi" && value != "sample" {
		return opts, fmt.Errorf("source must be all, pi, or sample")
	}
	return opts, nil
}

func (o listOptions) where(kind string) (string, []any) {
	parts, args := []string{"1=1"}, []any{}
	if source := o.values.Get("source"); source == "pi" {
		parts = append(parts, "t.source='pi'")
	} else if source == "sample" {
		parts = append(parts, "t.source<>'pi'")
	}
	if environment := o.values.Get("environment"); environment != "" && environment != "all" {
		parts = append(parts, "t.environment=?")
		args = append(args, environment)
	}
	stamp := "t.timestamp_ms"
	if kind == "scores" {
		stamp = "s.timestamp_ms"
	}
	if o.from != nil {
		parts = append(parts, stamp+">=?")
		args = append(args, *o.from)
	}
	if o.to != nil {
		parts = append(parts, stamp+"<=?")
		args = append(args, *o.to)
	}
	if kind == "traces" {
		if level := o.values.Get("level"); level != "" && level != "all" {
			parts = append(parts, "t.level=?")
			args = append(args, level)
		}
		if names := o.values["names"]; len(names) > 0 {
			placeholders := make([]string, len(names))
			for i, name := range names {
				placeholders[i] = "?"
				args = append(args, name)
			}
			parts = append(parts, "t.name IN ("+strings.Join(placeholders, ",")+")")
		}
		switch o.values.Get("preset") {
		case "bookmarked":
			parts = append(parts, "t.bookmarked=1")
		case "errors":
			parts = append(parts, "t.level='ERROR'")
		case "slow":
			parts = append(parts, "t.latency>5")
		}
	}
	if kind == "scores" {
		if source := o.values.Get("scoreSource"); source != "" && source != "all" {
			parts = append(parts, "s.source=?")
			args = append(args, source)
		}
		if name := o.values.Get("scoreName"); name != "" && name != "all" {
			parts = append(parts, "s.name=?")
			args = append(args, name)
		}
	}
	if q := strings.TrimSpace(o.values.Get("q")); q != "" {
		if kind == "sessions" {
			inner := strings.ReplaceAll(strings.Join(parts, " AND "), "t.", "u.")
			parts = append(parts, "t.session_id IN (SELECT u.session_id FROM traces u WHERE "+inner+" GROUP BY u.session_id HAVING instr(unicode_lower(u.session_id || ' ' || MIN(u.user_id)),unicode_lower(?))>0)")
			args = append(append(args, args...), q)
		} else if kind == "scores" {
			parts = append(parts, "instr(unicode_lower(s.name || ' ' || s.trace_name || ' ' || s.comment || ' ' || s.trace_id),unicode_lower(?))>0")
			args = append(args, q)
		} else {
			columns := []string{"t.id", "t.name", "t.user_id", "t.session_id", "t.input", "t.output", "t.model"}
			for _, term := range strings.Fields(q) {
				search := make([]string, len(columns))
				for i, column := range columns {
					search[i] = "instr(unicode_lower(" + column + "),unicode_lower(?))>0"
					args = append(args, term)
				}
				search = append(search, "EXISTS (SELECT 1 FROM json_each(t.tags) WHERE instr(unicode_lower(value),unicode_lower(?))>0)")
				args = append(args, term)
				parts = append(parts, "("+strings.Join(search, " OR ")+")")
			}
		}
	}
	return strings.Join(parts, " AND "), args
}

func (o listOptions) without(key string) listOptions {
	values := make(url.Values, len(o.values))
	for name, value := range o.values {
		if name != key {
			values[name] = value
		}
	}
	o.values = values
	return o
}

func (o listOptions) order() string {
	column := map[string]string{"timestamp": "t.timestamp_ms", "name": "t.name", "latency": "t.latency", "tokens": "t.total_tokens", "cost": "t.cost"}[o.values.Get("sort")]
	if column == "" {
		column = "t.timestamp_ms"
	}
	direction := " DESC"
	if o.values.Get("order") == "asc" {
		direction = " ASC"
	}
	return column + direction + ",t.id ASC"
}

func pageResult(data any, total int, opts listOptions) map[string]any {
	result := map[string]any{"data": data}
	if opts.size > 0 {
		result["total"], result["page"], result["pageSize"] = total, opts.page, opts.size
	}
	return result
}

func readOptions(w http.ResponseWriter, r *http.Request) (listOptions, bool) {
	opts, err := options(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return opts, false
	}
	return opts, true
}

func (a *app) traces(w http.ResponseWriter, r *http.Request) {
	opts, ok := readOptions(w, r)
	if !ok {
		return
	}
	tx, err := a.store.db.BeginTx(r.Context(), nil)
	if err != nil {
		storeError(w, "Read traces", err)
		return
	}
	defer tx.Rollback()
	where, args := opts.where("traces")
	var total int
	if err := tx.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM traces t WHERE "+where, args...).Scan(&total); err != nil {
		storeError(w, "Count traces", err)
		return
	}
	traces, err := queryTraces(r.Context(), tx, where, args, opts.order(), opts.page, opts.size, opts.size == 0, opts.size == 0)
	if err != nil {
		storeError(w, "Read traces", err)
		return
	}
	writeJSON(w, http.StatusOK, pageResult(traces, total, opts))
}

func (a *app) scores(w http.ResponseWriter, r *http.Request) {
	opts, ok := readOptions(w, r)
	if !ok {
		return
	}
	tx, err := a.store.db.BeginTx(r.Context(), nil)
	if err != nil {
		storeError(w, "Read scores", err)
		return
	}
	defer tx.Rollback()
	where, args := opts.where("scores")
	var total int
	if err := tx.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM scores s JOIN traces t ON t.id=s.trace_id WHERE "+where, args...).Scan(&total); err != nil {
		storeError(w, "Count scores", err)
		return
	}
	scores, err := queryScores(r.Context(), tx, where, args, opts.page, opts.size, false)
	if err != nil {
		storeError(w, "Read scores", err)
		return
	}
	writeJSON(w, http.StatusOK, pageResult(scores, total, opts))
}

func querySessions(ctx context.Context, db queryer, where string, args []any, page, size int) ([]Session, error) {
	query := `SELECT t.session_id,MIN(t.timestamp_ms),MAX(t.timestamp_ms+t.latency*1000),COUNT(*),SUM(t.total_tokens),SUM(t.cost),SUM(t.latency),json_group_array(t.id),
 MIN(t.user_id),MIN(t.environment)
 FROM traces t WHERE ` + where + ` GROUP BY t.session_id ORDER BY MIN(t.timestamp_ms) DESC,t.session_id`
	if size > 0 {
		query += " LIMIT ? OFFSET ?"
		args = append(append([]any{}, args...), size, (page-1)*size)
	}
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Session{}
	for rows.Next() {
		var session Session
		var start int64
		var end float64
		var ids string
		if err := rows.Scan(&session.ID, &start, &end, &session.TraceCount, &session.TotalTokens, &session.Cost, &session.Latency, &ids, &session.UserID, &session.Environment); err != nil {
			return nil, err
		}
		session.StartTime = time.UnixMilli(start).UTC().Format(time.RFC3339Nano)
		session.EndTime = time.UnixMilli(int64(end)).UTC().Format(time.RFC3339Nano)
		session.Cost = round(session.Cost, 8)
		session.Latency = round(session.Latency, 3)
		if err := json.Unmarshal([]byte(ids), &session.TraceIDs); err != nil {
			return nil, err
		}
		result = append(result, session)
	}
	return result, rows.Err()
}

func (a *app) sessions(w http.ResponseWriter, r *http.Request) {
	opts, ok := readOptions(w, r)
	if !ok {
		return
	}
	tx, err := a.store.db.BeginTx(r.Context(), nil)
	if err != nil {
		storeError(w, "Read sessions", err)
		return
	}
	defer tx.Rollback()
	where, args := opts.where("sessions")
	var total int
	if err := tx.QueryRowContext(r.Context(), "SELECT COUNT(DISTINCT t.session_id) FROM traces t WHERE "+where, args...).Scan(&total); err != nil {
		storeError(w, "Count sessions", err)
		return
	}
	sessions, err := querySessions(r.Context(), tx, where, args, opts.page, opts.size)
	if err != nil {
		storeError(w, "Read sessions", err)
		return
	}
	writeJSON(w, http.StatusOK, pageResult(sessions, total, opts))
}

func (a *app) session(w http.ResponseWriter, r *http.Request) {
	opts, ok := readOptions(w, r)
	if !ok {
		return
	}
	tx, err := a.store.db.BeginTx(r.Context(), nil)
	if err != nil {
		storeError(w, "Read session", err)
		return
	}
	defer tx.Rollback()
	where, args := opts.where("sessions")
	where += " AND t.session_id=?"
	args = append(args, r.PathValue("id"))
	sessions, err := querySessions(r.Context(), tx, where, args, 0, 0)
	if err != nil {
		storeError(w, "Read session", err)
		return
	}
	if len(sessions) == 0 {
		writeError(w, http.StatusNotFound, "Session not found in this scope")
		return
	}
	traces, err := queryTraces(r.Context(), tx, where, args, "t.timestamp_ms ASC,t.id", 0, 0, true, false)
	if err != nil {
		storeError(w, "Read session traces", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"session": sessions[0], "traces": traces})
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

func queryCounts(ctx context.Context, db queryer, query string, args []any) ([]nameSummary, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []nameSummary{}
	for rows.Next() {
		var item nameSummary
		if err := rows.Scan(&item.Name, &item.Count); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (a *app) overview(w http.ResponseWriter, r *http.Request) {
	opts, ok := readOptions(w, r)
	if !ok {
		return
	}
	tx, err := a.store.db.BeginTx(r.Context(), nil)
	if err != nil {
		storeError(w, "Read overview", err)
		return
	}
	defer tx.Rollback()
	result, err := queryOverview(r.Context(), tx, opts)
	if err != nil {
		storeError(w, "Read overview", err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func queryOverview(ctx context.Context, db queryer, opts listOptions) (map[string]any, error) {
	where, args := opts.where("traces")
	var count, tokens int
	var cost, latency, errorRate float64
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*),COALESCE(SUM(t.total_tokens),0),COALESCE(SUM(t.cost),0),COALESCE(AVG(t.latency),0),COALESCE(100.0*SUM(t.level='ERROR')/NULLIF(COUNT(*),0),0) FROM traces t WHERE `+where, args...).Scan(&count, &tokens, &cost, &latency, &errorRate); err != nil {
		return nil, err
	}
	var scoreAverage float64
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(AVG(s.value),0) FROM scores s JOIN traces t ON t.id=s.trace_id WHERE `+where, args...).Scan(&scoreAverage); err != nil {
		return nil, err
	}
	names, err := queryCounts(ctx, db, `SELECT t.name,COUNT(*) FROM traces t WHERE `+where+` GROUP BY t.name ORDER BY COUNT(*) DESC,t.name`, args)
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `WITH scoped AS (SELECT * FROM traces t WHERE `+where+`), usage AS (
 SELECT o.model name,o.input_tokens+o.output_tokens tokens,o.cost cost FROM observations o JOIN scoped t ON t.id=o.trace_id WHERE o.type='GENERATION'
 UNION ALL SELECT t.model,t.total_tokens,t.cost FROM scoped t WHERE t.source<>'pi' AND NOT EXISTS(SELECT 1 FROM observations o WHERE o.trace_id=t.id)
 ) SELECT CASE WHEN name='' THEN 'Unknown' ELSE name END,SUM(tokens),SUM(cost),COUNT(*) FROM usage GROUP BY CASE WHEN name='' THEN 'Unknown' ELSE name END ORDER BY SUM(tokens) DESC,name`, args...)
	if err != nil {
		return nil, err
	}
	models := []modelSummary{}
	for rows.Next() {
		var model modelSummary
		if err := rows.Scan(&model.Name, &model.Tokens, &model.Cost, &model.Count); err != nil {
			rows.Close()
			return nil, err
		}
		model.Cost = round(model.Cost, 8)
		models = append(models, model)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	rows, err = db.QueryContext(ctx, `SELECT date(t.timestamp_ms/1000,'unixepoch'),COUNT(*),SUM(t.total_tokens),SUM(t.cost),AVG(t.latency) FROM traces t WHERE `+where+` GROUP BY date(t.timestamp_ms/1000,'unixepoch') ORDER BY 1`, args...)
	if err != nil {
		return nil, err
	}
	points := []seriesPoint{}
	byDate := map[string]seriesPoint{}
	for rows.Next() {
		var point seriesPoint
		if err := rows.Scan(&point.Date, &point.Count, &point.Tokens, &point.Cost, &point.Latency); err != nil {
			rows.Close()
			return nil, err
		}
		point.Cost = round(point.Cost, 8)
		point.Latency = round(point.Latency, 3)
		points = append(points, point)
		byDate[point.Date] = point
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	end := time.Now().UTC()
	if opts.to != nil {
		end = time.UnixMilli(*opts.to).UTC()
	}
	start := end.AddDate(0, 0, -6)
	if opts.from != nil {
		start = time.UnixMilli(*opts.from).UTC()
	} else if len(points) > 0 {
		start, _ = time.Parse(time.DateOnly, points[0].Date)
	}
	start = time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, time.UTC)
	if end.Sub(start) <= 3660*24*time.Hour {
		points = []seriesPoint{}
		for day := start; !day.After(end); day = day.AddDate(0, 0, 1) {
			date := day.Format(time.DateOnly)
			point, ok := byDate[date]
			if !ok {
				point = seriesPoint{Date: date}
			}
			points = append(points, point)
		}
	}
	recent, err := queryTraces(ctx, db, where, args, "t.timestamp_ms DESC,t.id", 1, 5, false, false)
	if err != nil {
		return nil, err
	}
	return map[string]any{"totalTraces": count, "totalTokens": tokens, "totalCost": round(cost, 8), "avgLatency": round(latency, 3), "errorRate": round(errorRate, 2), "scoreAverage": round(scoreAverage, 4), "series": points, "models": models, "names": names, "recentTraces": recent}, nil
}

func (a *app) filters(w http.ResponseWriter, r *http.Request) {
	opts, ok := readOptions(w, r)
	if !ok {
		return
	}
	tx, err := a.store.db.BeginTx(r.Context(), nil)
	if err != nil {
		storeError(w, "Read filters", err)
		return
	}
	defer tx.Rollback()
	result, err := queryFilters(r.Context(), tx, opts)
	if err != nil {
		storeError(w, "Read filters", err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func queryFilters(ctx context.Context, db queryer, opts listOptions) (map[string]any, error) {
	where, args := opts.where("traces")
	var total, scopeTotal int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM traces").Scan(&total); err != nil {
		return nil, err
	}
	environments, err := queryCounts(ctx, db, "SELECT environment,COUNT(*) FROM traces GROUP BY environment ORDER BY environment", nil)
	if err != nil {
		return nil, err
	}
	nameWhere, nameArgs := opts.without("names").where("traces")
	names, err := queryCounts(ctx, db, "SELECT n.name,COUNT(t.id) FROM (SELECT DISTINCT name FROM traces) n LEFT JOIN traces t ON t.name=n.name AND "+nameWhere+" GROUP BY n.name ORDER BY n.name", nameArgs)
	if err != nil {
		return nil, err
	}
	levelWhere, levelArgs := opts.without("level").where("traces")
	levels, err := queryCounts(ctx, db, "SELECT t.level,COUNT(*) FROM traces t WHERE "+levelWhere+" GROUP BY t.level ORDER BY t.level", levelArgs)
	if err != nil {
		return nil, err
	}
	for _, level := range levels {
		scopeTotal += level.Count
	}
	sourceOpts := opts
	sourceOpts.values = url.Values{}
	sourceOpts.values.Set("environment", opts.values.Get("environment"))
	sourceWhere, sourceArgs := sourceOpts.where("traces")
	counts, err := queryCounts(ctx, db, "SELECT CASE WHEN t.source='pi' THEN 'pi' ELSE 'sample' END,COUNT(*) FROM traces t WHERE "+sourceWhere+" GROUP BY 1", sourceArgs)
	if err != nil {
		return nil, err
	}
	sourceCounts := map[string]int{"pi": 0, "sample": 0}
	for _, count := range counts {
		sourceCounts[count.Name] = count.Count
	}
	scoreOpts := opts
	scoreOpts.values = url.Values{}
	for _, key := range []string{"source", "environment"} {
		scoreOpts.values.Set(key, opts.values.Get(key))
	}
	scoreWhere, scoreArgs := scoreOpts.where("scores")
	scoreNames, err := queryCounts(ctx, db, "SELECT s.name,COUNT(*) FROM scores s JOIN traces t ON t.id=s.trace_id WHERE "+scoreWhere+" GROUP BY s.name ORDER BY s.name", scoreArgs)
	if err != nil {
		return nil, err
	}
	namesOnly := []string{}
	for _, name := range scoreNames {
		namesOnly = append(namesOnly, name.Name)
	}
	type bin struct {
		Count  int `json:"count"`
		Errors int `json:"errors"`
	}
	histogram := make([]bin, 48)
	end := time.Now().UnixMilli()
	if opts.to != nil {
		end = *opts.to
	}
	start := end - int64(7*24*time.Hour/time.Millisecond)
	if opts.from != nil {
		start = *opts.from
	}
	width := float64(end-start) / 48
	if width < 1 {
		width = 1
	}
	histArgs := append([]any{start, width}, args...)
	rows, err := db.QueryContext(ctx, "SELECT MIN(47,MAX(0,CAST((t.timestamp_ms-?)/? AS INTEGER))),COUNT(*),SUM(t.level='ERROR') FROM traces t WHERE "+where+" GROUP BY 1", histArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var index int
		var item bin
		if err := rows.Scan(&index, &item.Count, &item.Errors); err != nil {
			return nil, err
		}
		histogram[index] = item
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return map[string]any{"totalTraces": total, "scopeTotal": scopeTotal, "sourceCounts": sourceCounts, "environments": environments, "names": names, "levels": levels, "scoreNames": namesOnly, "histogram": histogram}, nil
}
