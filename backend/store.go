package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"modernc.org/sqlite"
)

func init() {
	sqlite.MustRegisterDeterministicScalarFunction("unicode_lower", 1, func(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
		if value, ok := args[0].(string); ok {
			return cases.Lower(language.Und).String(value), nil
		}
		return args[0], nil
	})
}

type Store struct {
	mu     sync.Mutex
	path   string
	db     *sql.DB
	writer *sql.DB
}

type storedData struct {
	Version int     `json:"version"`
	Traces  []Trace `json:"traces"`
}

type queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

const schema = `
CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS traces (
 id TEXT PRIMARY KEY, source TEXT NOT NULL, status TEXT NOT NULL, revision TEXT NOT NULL,
 name TEXT NOT NULL, timestamp TEXT NOT NULL, timestamp_ms INTEGER NOT NULL,
 environment TEXT NOT NULL, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
 latency REAL NOT NULL, total_tokens INTEGER NOT NULL, input_tokens INTEGER NOT NULL,
 output_tokens INTEGER NOT NULL, cost REAL NOT NULL, level TEXT NOT NULL,
 tags TEXT NOT NULL, bookmarked INTEGER NOT NULL, input TEXT NOT NULL, output TEXT NOT NULL,
 metadata TEXT NOT NULL, model TEXT NOT NULL, version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
 trace_id TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE, id TEXT NOT NULL,
 position INTEGER NOT NULL, parent_id TEXT, name TEXT NOT NULL, type TEXT NOT NULL,
 start_time REAL NOT NULL, duration REAL NOT NULL, level TEXT NOT NULL, status TEXT NOT NULL,
 model TEXT NOT NULL, input TEXT NOT NULL, output TEXT NOT NULL, input_tokens INTEGER NOT NULL,
 output_tokens INTEGER NOT NULL, cost REAL NOT NULL, metadata TEXT NOT NULL,
 PRIMARY KEY (trace_id, id)
);
CREATE TABLE IF NOT EXISTS scores (
 id TEXT PRIMARY KEY, trace_id TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
 trace_name TEXT NOT NULL, name TEXT NOT NULL, value REAL NOT NULL, comment TEXT NOT NULL,
 source TEXT NOT NULL, timestamp TEXT NOT NULL, timestamp_ms INTEGER NOT NULL, data_type TEXT NOT NULL, position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS traces_timestamp ON traces(timestamp_ms DESC, id);
CREATE INDEX IF NOT EXISTS traces_source_time ON traces(source, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS traces_environment_time ON traces(environment, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS traces_session_time ON traces(session_id, timestamp_ms);
CREATE INDEX IF NOT EXISTS traces_name_time ON traces(name, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS traces_level_time ON traces(level, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS traces_bookmarked_time ON traces(bookmarked, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS observations_type_model ON observations(type, model, trace_id);
CREATE INDEX IF NOT EXISTS scores_trace ON scores(trace_id, position);
CREATE INDEX IF NOT EXISTS scores_timestamp ON scores(timestamp_ms DESC, id);
CREATE INDEX IF NOT EXISTS scores_name_time ON scores(name, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS scores_source_time ON scores(source, timestamp_ms DESC);
`

func openStore(path string) (*Store, error) {
	legacy := ""
	if strings.EqualFold(filepath.Ext(path), ".json") {
		legacy = path
		path = strings.TrimSuffix(path, filepath.Ext(path)) + ".db"
	} else if filepath.Base(path) == "elune.db" {
		legacy = filepath.Join(filepath.Dir(path), "store.json")
	}
	path, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return nil, fmt.Errorf("database path must be a regular file")
	} else if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = file.Chmod(0600); err != nil {
		file.Close()
		return nil, err
	}
	if err = file.Close(); err != nil {
		return nil, err
	}
	params := url.Values{"_pragma": {"busy_timeout(5000)", "foreign_keys(1)", "synchronous(FULL)"}, "_txlock": {"immediate"}}
	dsn := (&url.URL{Scheme: "file", Path: path, RawQuery: params.Encode()}).String()
	writer, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	writer.SetMaxOpenConns(1)
	s := &Store{path: path, writer: writer}
	ok := false
	defer func() {
		if !ok {
			s.Close()
		}
	}()
	var mode string
	if err := writer.QueryRow("PRAGMA journal_mode=WAL").Scan(&mode); err != nil {
		return nil, err
	}
	if mode != "wal" {
		return nil, fmt.Errorf("could not enable SQLite WAL mode")
	}
	if err := s.initialize(legacy); err != nil {
		return nil, err
	}
	params.Del("_txlock")
	params.Add("_pragma", "query_only(1)")
	dsn = (&url.URL{Scheme: "file", Path: path, RawQuery: params.Encode()}).String()
	s.db, err = sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	s.db.SetMaxOpenConns(4)
	if err := s.db.Ping(); err != nil {
		return nil, err
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if err := os.Chmod(path+suffix, 0600); err != nil && !os.IsNotExist(err) {
			return nil, err
		}
	}
	ok = true
	return s, nil
}

func (s *Store) Close() error {
	var readErr error
	if s.db != nil {
		readErr = s.db.Close()
	}
	if s.writer != nil {
		return errors.Join(readErr, s.writer.Close())
	}
	return readErr
}

func (s *Store) initialize(legacy string) error {
	tx, err := s.writer.BeginTx(context.Background(), nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(schema); err != nil {
		return err
	}
	var version string
	err = tx.QueryRow("SELECT value FROM store_meta WHERE key='version'").Scan(&version)
	if err == nil {
		if version != "1" {
			return fmt.Errorf("unsupported database version: %s", version)
		}
		return tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var traces []Trace
	if legacy != "" {
		b, err := os.ReadFile(legacy)
		if err == nil {
			var data storedData
			if err := json.Unmarshal(b, &data); err != nil {
				return fmt.Errorf("import legacy store: %w", err)
			}
			if data.Version != 1 || data.Traces == nil {
				return fmt.Errorf("unsupported or invalid legacy store")
			}
			traces = data.Traces
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("read legacy store: %w", err)
		}
	}
	if traces == nil {
		traces = seedTraces(time.Now().UTC())
	}
	ids := map[string]bool{}
	for _, trace := range traces {
		if trace.ID == "" || ids[trace.ID] {
			return fmt.Errorf("legacy store contains an empty or duplicate trace identifier")
		}
		ids[trace.ID] = true
		if err := writeTrace(context.Background(), tx, trace, true); err != nil {
			return fmt.Errorf("initialize trace data: %w", err)
		}
	}
	if _, err := tx.Exec("INSERT INTO store_meta(key,value) VALUES('version','1')"); err != nil {
		return err
	}
	return tx.Commit()
}

func millis(timestamp string) (int64, error) {
	value, err := time.Parse(time.RFC3339Nano, timestamp)
	if err != nil {
		return 0, err
	}
	return value.UnixMilli(), nil
}

func writeTrace(ctx context.Context, tx *sql.Tx, trace Trace, includeScores bool) error {
	stamp, err := millis(trace.Timestamp)
	if err != nil {
		return err
	}
	if trace.Tags == nil {
		trace.Tags = []string{}
	}
	tags, err := json.Marshal(trace.Tags)
	if err != nil {
		return err
	}
	metadata, err := json.Marshal(trace.Metadata)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO traces (
 id,source,status,revision,name,timestamp,timestamp_ms,environment,user_id,session_id,
 latency,total_tokens,input_tokens,output_tokens,cost,level,tags,bookmarked,input,output,metadata,model,version
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
 source=excluded.source,status=excluded.status,revision=excluded.revision,name=excluded.name,
 timestamp=excluded.timestamp,timestamp_ms=excluded.timestamp_ms,environment=excluded.environment,
 user_id=excluded.user_id,session_id=excluded.session_id,latency=excluded.latency,total_tokens=excluded.total_tokens,
 input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cost=excluded.cost,level=excluded.level,
 tags=excluded.tags,bookmarked=excluded.bookmarked,input=excluded.input,output=excluded.output,
 metadata=excluded.metadata,model=excluded.model,version=excluded.version`,
		trace.ID, trace.Source, trace.Status, strconv.FormatUint(trace.Revision, 10), trace.Name, trace.Timestamp, stamp,
		trace.Environment, trace.UserID, trace.SessionID, trace.Latency, trace.TotalTokens, trace.InputTokens,
		trace.OutputTokens, trace.Cost, trace.Level, string(tags), trace.Bookmarked, trace.Input, trace.Output,
		string(metadata), trace.Model, trace.Version)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM observations WHERE trace_id=?", trace.ID); err != nil {
		return err
	}
	statement, err := tx.PrepareContext(ctx, `INSERT INTO observations(trace_id,id,position,parent_id,name,type,start_time,duration,level,status,model,input,output,input_tokens,output_tokens,cost,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer statement.Close()
	for position, observation := range trace.Observations {
		if observation.ID == "" {
			return fmt.Errorf("observation identifier is empty")
		}
		metadata, err := json.Marshal(observation.Metadata)
		if err != nil {
			return err
		}
		if _, err := statement.ExecContext(ctx, trace.ID, observation.ID, position, observation.ParentID,
			observation.Name, observation.Type, observation.StartTime, observation.Duration, observation.Level,
			observation.Status, observation.Model, observation.Input, observation.Output, observation.InputTokens,
			observation.OutputTokens, observation.Cost, string(metadata)); err != nil {
			return err
		}
	}
	if includeScores {
		for _, score := range trace.Scores {
			if score.TraceID != trace.ID {
				return fmt.Errorf("score belongs to a different trace")
			}
			if err := insertScore(ctx, tx, score); err != nil {
				return err
			}
		}
	}
	return nil
}

func insertScore(ctx context.Context, tx *sql.Tx, score Score) error {
	if score.ID == "" {
		return fmt.Errorf("score identifier is empty")
	}
	stamp, err := millis(score.Timestamp)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO scores(id,trace_id,trace_name,name,value,comment,source,timestamp,timestamp_ms,data_type,position) VALUES(?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(position),-1)+1 FROM scores WHERE trace_id=?))`, score.ID, score.TraceID, score.TraceName, score.Name, score.Value, score.Comment, score.Source, score.Timestamp, stamp, score.DataType, score.TraceID)
	return err
}

const traceColumns = `t.id,t.source,t.status,t.revision,t.name,t.timestamp,t.environment,t.user_id,t.session_id,t.latency,t.total_tokens,t.input_tokens,t.output_tokens,t.cost,t.level,t.tags,t.bookmarked,t.model,t.version`

func queryTraces(ctx context.Context, db queryer, where string, args []any, order string, page, size int, payload, observations bool) ([]Trace, error) {
	columns := traceColumns + ",t.input,t.output,t.metadata"
	if !payload {
		columns = traceColumns + ",substr(t.input,1,500),substr(t.output,1,500),'null'"
	}
	query := "SELECT " + columns + " FROM traces t WHERE " + where + " ORDER BY " + order
	if size > 0 {
		query += " LIMIT ? OFFSET ?"
		args = append(append([]any{}, args...), size, (page-1)*size)
	}
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	traces := []Trace{}
	for rows.Next() {
		var trace Trace
		var tags, metadata, revision string
		if err := rows.Scan(&trace.ID, &trace.Source, &trace.Status, &revision, &trace.Name, &trace.Timestamp,
			&trace.Environment, &trace.UserID, &trace.SessionID, &trace.Latency, &trace.TotalTokens, &trace.InputTokens,
			&trace.OutputTokens, &trace.Cost, &trace.Level, &tags, &trace.Bookmarked, &trace.Model, &trace.Version,
			&trace.Input, &trace.Output, &metadata); err != nil {
			rows.Close()
			return nil, err
		}
		trace.Revision, err = strconv.ParseUint(revision, 10, 64)
		if err != nil {
			rows.Close()
			return nil, err
		}
		if err := json.Unmarshal([]byte(tags), &trace.Tags); err != nil {
			rows.Close()
			return nil, err
		}
		if err := json.Unmarshal([]byte(metadata), &trace.Metadata); err != nil {
			rows.Close()
			return nil, err
		}
		trace.Scores = []Score{}
		trace.Observations = []Observation{}
		traces = append(traces, trace)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range traces {
		traces[i].Scores, err = queryScores(ctx, db, "s.trace_id=?", []any{traces[i].ID}, 0, 0, true)
		if err != nil {
			return nil, err
		}
		if observations {
			traces[i].Observations, err = queryObservations(ctx, db, traces[i].ID)
			if err != nil {
				return nil, err
			}
		}
	}
	return traces, nil
}

func queryObservations(ctx context.Context, db queryer, id string) ([]Observation, error) {
	rows, err := db.QueryContext(ctx, `SELECT id,parent_id,name,type,start_time,duration,level,status,model,input,output,input_tokens,output_tokens,cost,metadata FROM observations WHERE trace_id=? ORDER BY position`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Observation{}
	for rows.Next() {
		var observation Observation
		var metadata string
		if err := rows.Scan(&observation.ID, &observation.ParentID, &observation.Name, &observation.Type, &observation.StartTime,
			&observation.Duration, &observation.Level, &observation.Status, &observation.Model, &observation.Input,
			&observation.Output, &observation.InputTokens, &observation.OutputTokens, &observation.Cost, &metadata); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(metadata), &observation.Metadata); err != nil {
			return nil, err
		}
		result = append(result, observation)
	}
	return result, rows.Err()
}

func queryScores(ctx context.Context, db queryer, where string, args []any, page, size int, traceOrder bool) ([]Score, error) {
	order := "s.timestamp_ms DESC,s.id"
	if traceOrder {
		order = "s.position,s.id"
	}
	query := `SELECT s.id,s.trace_id,s.trace_name,s.name,s.value,s.comment,s.source,s.timestamp,s.data_type FROM scores s JOIN traces t ON t.id=s.trace_id WHERE ` + where + " ORDER BY " + order
	if size > 0 {
		query += " LIMIT ? OFFSET ?"
		args = append(append([]any{}, args...), size, (page-1)*size)
	}
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []Score{}
	for rows.Next() {
		var score Score
		if err := rows.Scan(&score.ID, &score.TraceID, &score.TraceName, &score.Name, &score.Value, &score.Comment, &score.Source, &score.Timestamp, &score.DataType); err != nil {
			return nil, err
		}
		result = append(result, score)
	}
	return result, rows.Err()
}

func getTrace(ctx context.Context, db queryer, id string) (Trace, error) {
	traces, err := queryTraces(ctx, db, "t.id=?", []any{id}, "t.id", 1, 1, true, true)
	if err != nil {
		return Trace{}, err
	}
	if len(traces) == 0 {
		return Trace{}, sql.ErrNoRows
	}
	return traces[0], nil
}
