package main

type Score struct {
	ID        string  `json:"id"`
	TraceID   string  `json:"traceId"`
	TraceName string  `json:"traceName"`
	Name      string  `json:"name"`
	Value     float64 `json:"value"`
	Comment   string  `json:"comment"`
	Source    string  `json:"source"`
	Timestamp string  `json:"timestamp"`
	DataType  string  `json:"dataType"`
}

type Observation struct {
	ID           string         `json:"id"`
	ParentID     *string        `json:"parentId"`
	Name         string         `json:"name"`
	Type         string         `json:"type"`
	StartTime    float64        `json:"startTime"`
	Duration     float64        `json:"duration"`
	Level        string         `json:"level"`
	Status       string         `json:"status,omitempty"`
	Model        string         `json:"model"`
	Input        string         `json:"input"`
	Output       string         `json:"output"`
	InputTokens  int            `json:"inputTokens"`
	OutputTokens int            `json:"outputTokens"`
	Cost         float64        `json:"cost"`
	Metadata     map[string]any `json:"metadata"`
}

type Trace struct {
	ID           string         `json:"id"`
	Source       string         `json:"source,omitempty"`
	Status       string         `json:"status,omitempty"`
	Revision     uint64         `json:"revision,omitempty"`
	Name         string         `json:"name"`
	Timestamp    string         `json:"timestamp"`
	Environment  string         `json:"environment"`
	UserID       string         `json:"userId"`
	SessionID    string         `json:"sessionId"`
	Latency      float64        `json:"latency"`
	TotalTokens  int            `json:"totalTokens"`
	InputTokens  int            `json:"inputTokens"`
	OutputTokens int            `json:"outputTokens"`
	Cost         float64        `json:"cost"`
	Level        string         `json:"level"`
	Tags         []string       `json:"tags"`
	Bookmarked   bool           `json:"bookmarked"`
	Input        string         `json:"input"`
	Output       string         `json:"output"`
	Metadata     map[string]any `json:"metadata"`
	Model        string         `json:"model"`
	Version      string         `json:"version"`
	Scores       []Score        `json:"scores"`
	Observations []Observation  `json:"observations"`
}

type Session struct {
	ID          string   `json:"id"`
	UserID      string   `json:"userId"`
	StartTime   string   `json:"startTime"`
	EndTime     string   `json:"endTime"`
	TraceCount  int      `json:"traceCount"`
	TotalTokens int      `json:"totalTokens"`
	Cost        float64  `json:"cost"`
	Latency     float64  `json:"latency"`
	Environment string   `json:"environment"`
	TraceIDs    []string `json:"traceIds"`
}
