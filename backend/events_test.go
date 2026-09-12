package main

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestEventsStreamIngestionAndAnnotations(t *testing.T) {
	a := testApp(t)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/events", a.events)
	server := httptest.NewUnstartedServer(mux)
	server.Config.WriteTimeout = 10 * time.Millisecond
	server.Start()
	defer server.Close()
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Get(server.URL + "/api/events")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatal("missing event stream content type")
	}
	reader := bufio.NewReader(response.Body)
	readEvent := func(name string) string {
		t.Helper()
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line != "event: "+name+"\n" {
			t.Fatalf("unexpected event: %q", line)
		}
		data, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if _, err := reader.ReadString('\n'); err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(strings.TrimPrefix(data, "data: "))
	}
	readEvent("ready")
	time.Sleep(20 * time.Millisecond)
	trace := testTrace()
	if result := ingestRequest(t, a, trace); result.Code != http.StatusCreated {
		t.Fatal(result.Body.String())
	}
	var notice traceNotice
	if err := json.Unmarshal([]byte(readEvent("traces")), &notice); err != nil {
		t.Fatal(err)
	}
	if notice.TraceID != trace.ID || notice.Revision != 1 {
		t.Fatalf("incorrect notice: %+v", notice)
	}
	annotationRequest(a, http.MethodPatch, "/api/traces/pi-trace-1", `{"bookmarked":true}`, a.bookmark)
	readEvent("traces")
	annotationRequest(a, http.MethodPost, "/api/traces/pi-trace-1/scores", `{"name":"quality","value":1}`, a.addScore)
	readEvent("traces")
	response.Body.Close()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		a.eventsMu.Lock()
		count := len(a.subscribers)
		a.eventsMu.Unlock()
		if count == 0 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("disconnected event subscriber was not removed")
}

func TestEventsCoalesceWithoutBlockingOrPublishingReplays(t *testing.T) {
	a := testApp(t)
	subscriber := make(chan traceNotice, 1)
	a.subscribers = map[chan traceNotice]struct{}{subscriber: {}}
	trace := testTrace()
	for revision := uint64(1); revision <= 4; revision++ {
		trace.Revision = revision
		if result := ingestRequest(t, a, trace); result.Code != http.StatusOK && result.Code != http.StatusCreated {
			t.Fatal(result.Body.String())
		}
	}
	if notice := <-subscriber; notice.Revision != 4 {
		t.Fatalf("slow subscriber did not receive latest revision: %+v", notice)
	}
	trace.Revision = 1
	ingestRequest(t, a, trace)
	if len(subscriber) != 0 {
		t.Fatal("replayed snapshot published a change")
	}
}
