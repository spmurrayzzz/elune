package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
)

type traceNotice struct {
	TraceID  string `json:"traceId"`
	Revision uint64 `json:"revision"`
}

func (a *app) broadcast(trace Trace) {
	a.eventsMu.Lock()
	defer a.eventsMu.Unlock()
	notice := traceNotice{TraceID: trace.ID, Revision: trace.Revision}
	for subscriber := range a.subscribers {
		select {
		case subscriber <- notice:
		default:
			select {
			case <-subscriber:
			default:
			}
			select {
			case subscriber <- notice:
			default:
			}
		}
	}
}

func (a *app) events(w http.ResponseWriter, r *http.Request) {
	controller := http.NewResponseController(w)
	if _, ok := w.(http.Flusher); !ok {
		writeError(w, http.StatusInternalServerError, "Streaming is unavailable")
		return
	}
	subscriber := make(chan traceNotice, 1)
	a.eventsMu.Lock()
	if a.subscribers == nil {
		a.subscribers = make(map[chan traceNotice]struct{})
	}
	a.subscribers[subscriber] = struct{}{}
	a.eventsMu.Unlock()
	defer func() {
		a.eventsMu.Lock()
		delete(a.subscribers, subscriber)
		a.eventsMu.Unlock()
	}()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	writeEvent := func(event string, data any) bool {
		if err := controller.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil && !errors.Is(err, http.ErrNotSupported) {
			return false
		}
		payload, err := json.Marshal(data)
		if err != nil {
			return false
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, payload); err != nil {
			return false
		}
		return controller.Flush() == nil
	}
	if !writeEvent("ready", struct{}{}) {
		return
	}
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case notice := <-subscriber:
			if !writeEvent("traces", notice) {
				return
			}
		case <-ticker.C:
			if !writeEvent("heartbeat", struct{}{}) {
				return
			}
		}
	}
}
