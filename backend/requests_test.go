package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLocalRequestsValidateHostAndOrigin(t *testing.T) {
	for _, tc := range []struct {
		name, host, origin string
		status             int
	}{
		{"Pi client", "127.0.0.1:8080", "", http.StatusNoContent},
		{"local browser", "localhost:8080", "http://localhost:8080", http.StatusNoContent},
		{"Vite browser", "127.0.0.1:8080", "http://localhost:5173", http.StatusNoContent},
		{"localhost without port", "localhost", "", http.StatusNoContent},
		{"case insensitive hostname", "LOCALHOST:8080", "", http.StatusNoContent},
		{"IPv6 with port", "[::1]:8080", "", http.StatusNoContent},
		{"IPv6 without port", "[::1]", "", http.StatusNoContent},
		{"rebound hostname", "review.invalid:8080", "", http.StatusForbidden},
		{"rebound host with local origin", "review.invalid", "http://localhost:5173", http.StatusForbidden},
		{"hostname suffix", "localhost.review.invalid", "", http.StatusForbidden},
		{"missing host", "", "", http.StatusForbidden},
		{"remote origin", "127.0.0.1:8080", "https://review.invalid", http.StatusForbidden},
		{"null origin", "127.0.0.1:8080", "null", http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			handler := localRequests(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			}))
			request := httptest.NewRequest(http.MethodGet, "/api/traces", nil)
			request.Host = tc.host
			request.Header.Set("Origin", tc.origin)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != tc.status || called != (tc.status == http.StatusNoContent) {
				t.Fatalf("status=%d handlerCalled=%v, want status=%d", response.Code, called, tc.status)
			}
		})
	}
}
