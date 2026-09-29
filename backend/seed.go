package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"time"
)

type scenario struct {
	name      string
	tags      []string
	questions []string
	answers   []string
	tool      string
	toolType  string
	toolInput map[string]any
	toolData  map[string]any
}

func seedTraces(now time.Time) []Trace {
	scenarios := []scenario{
		{
			name: "support-agent",
			tags: []string{"customer-support", "rag"},
			questions: []string{
				"I was charged twice for my Pro subscription this month. Can you help me get a refund?",
				"Can you confirm which charge will be refunded and how long it will take?",
				"Will this change my subscription or access to the Pro features?",
				"Thanks. Please send me a summary with the refund reference number.",
			},
			answers: []string{
				"I found two $29.00 charges on your account for the same billing period. The second charge was a duplicate.\n\nI have submitted a refund of $29.00 to your original payment method. It usually appears within 5–10 business days. Your Pro subscription remains active.\n\nRefund reference: RF-2026-0842. Is there anything else I can help with?",
				"The duplicate $29.00 charge ending in transaction 0842 will be refunded to your Visa ending in 4242. The original subscription payment will remain. You should see the credit within 5–10 business days, depending on your bank.",
				"Your Pro subscription and all Pro features will remain active. The refund only applies to the duplicate payment. Your next billing date and plan price will stay the same.",
				"Here is your refund summary:\n\n• Amount: $29.00\n• Reason: duplicate subscription charge\n• Payment method: Visa ending in 4242\n• Expected arrival: 5–10 business days\n• Reference: RF-2026-0842\n\nYour Pro subscription remains active. I have added this summary to your support case.",
			},
			tool:      "search-knowledge-base",
			toolType:  "RETRIEVER",
			toolInput: map[string]any{"query": "duplicate subscription charge refund policy", "top_k": 3, "namespace": "support-docs"},
			toolData:  map[string]any{"documents": []map[string]any{{"title": "Refunds and duplicate charges", "score": 0.94, "content": "Duplicate charges qualify for a full refund. Refunds return to the original payment method within 5–10 business days."}, {"title": "Managing your subscription", "score": 0.88, "content": "Refunding a duplicate charge does not affect the active subscription."}}, "total_results": 2},
		},
		{
			name: "research-agent",
			tags: []string{"research", "web-search"},
			questions: []string{
				"Compare retrieval-augmented generation and fine-tuning for our internal knowledge assistant.",
				"How should we evaluate whether retrieval is returning the right documents?",
				"What would a small pilot look like for a team of 50 engineers?",
				"Summarize the recommendation and the main risks for our technical lead.",
			},
			answers: []string{
				"For an internal knowledge assistant, start with retrieval-augmented generation (RAG).\n\nRAG retrieves current documents at query time and can provide citations. It is a good fit for policies, runbooks, and documentation that change often. Fine-tuning is more useful for consistent format, style, or specialized behavior.\n\nA practical approach is to index the internal documentation, add permission-aware retrieval, and evaluate citation accuracy against a small set of real questions. Consider fine-tuning later if response behavior remains inconsistent.",
				"Build an evaluation set of 50–100 real questions with relevant document passages labeled by subject-matter experts. Measure recall at 5, ranking quality, and whether the retrieved context supports the final answer. Include outdated documents, ambiguous questions, and questions with no answer. Review failures by source and document type.",
				"Run a two-week pilot with 10 volunteers and a limited set of engineering runbooks. Use read-only access, preserve document permissions, and log retrieved passages and feedback. Track answer usefulness, citation accuracy, unanswered questions, and time saved. Expand after the team reviews recurring failure cases.",
				"Recommendation: use RAG for a limited engineering knowledge pilot. It keeps answers connected to current source documents and supports citations.\n\nMain risks: stale indexing, access-control mistakes, irrelevant retrieval, and answers that exceed the evidence. Mitigate these with permission checks, freshness monitoring, a labeled evaluation set, and an explicit fallback when sources are insufficient.",
			},
			tool:      "web-search",
			toolType:  "TOOL",
			toolInput: map[string]any{"query": "retrieval augmented generation fine tuning enterprise knowledge evaluation", "max_results": 5},
			toolData:  map[string]any{"results": []map[string]any{{"title": "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks", "url": "https://arxiv.org/abs/2005.11401", "relevance": 0.97}, {"title": "Retrieval evaluation guide", "source": "internal/engineering/search-evaluation", "relevance": 0.91}}, "sources_checked": 5},
		},
		{
			name: "document-analysis",
			tags: []string{"documents", "extraction"},
			questions: []string{
				"Extract the key obligations and renewal terms from the uploaded vendor agreement.",
				"Which obligations have deadlines we should add to our contract calendar?",
				"Does the agreement say anything about deleting our data after termination?",
				"Give me a short checklist for our procurement review.",
			},
			answers: []string{
				"The agreement contains four key obligations:\n\n1. Payment is due within 30 days of invoice receipt (section 4.2).\n2. The vendor must maintain 99.9% monthly availability (section 6.1).\n3. Each party must protect confidential information for three years after termination (section 9.3).\n4. The vendor must delete customer data within 30 days of termination (section 11.4).\n\nThe agreement renews for successive one-year terms unless either party gives written notice at least 60 days before the current term ends (section 3.2).",
				"Add these dates to the contract calendar: invoice due dates at 30 days after receipt; the non-renewal notice deadline 60 days before the annual term ends; and the data-deletion confirmation deadline 30 days after any termination. The agreement also requires quarterly service reviews, but does not specify a day of the month.",
				"Yes. Section 11.4 requires the vendor to delete customer data within 30 days after termination and provide written confirmation on request. A separate exception allows retention when required by law. Ask the vendor how this applies to backups and what evidence their confirmation will contain.",
				"Procurement review checklist:\n\n• Confirm the renewal date and assign an owner for the 60-day notice deadline.\n• Verify the service-credit process for the 99.9% availability commitment.\n• Check the permitted data-retention exceptions.\n• Request the current security assurance report.\n• Confirm that pricing and usage limits match the order form.\n\nThese points come from the uploaded agreement and need review against your internal requirements.",
			},
			tool:      "extract-document-sections",
			toolType:  "TOOL",
			toolInput: map[string]any{"document_id": "doc_vendor_agreement_2026", "sections": []string{"term", "payment", "availability", "data_retention"}},
			toolData:  map[string]any{"document": "vendor-agreement.pdf", "pages": 14, "sections": []map[string]any{{"section": "3.2", "text": "The term renews annually unless written notice is received sixty days before expiry."}, {"section": "11.4", "text": "Customer Data shall be deleted within thirty days following termination, except as required by law."}}, "confidence": 0.98},
		},
		{
			name: "travel-planner",
			tags: []string{"planning", "tool-use"},
			questions: []string{
				"Plan a relaxed three-day trip to Lisbon for two people with a €900 budget, excluding flights.",
				"Can you suggest a quieter alternative to the busiest spots on the first day?",
				"How much should we set aside for food and local transport?",
				"Put the final plan into a day-by-day itinerary with estimated costs.",
			},
			answers: []string{
				"Here is a relaxed three-day Lisbon plan for two, with an estimated total of €840.\n\nDay 1: Explore Alfama, walk to the river, and have dinner in Graça.\nDay 2: Visit Belém in the morning, then leave the afternoon open for cafés and the waterfront.\nDay 3: Take a slow morning in Estrela and visit a museum or neighborhood market.\n\nBudget: €420 for three nights, €240 for food, €60 for local transport, €70 for attractions, and €50 contingency. These are planning estimates, and availability may change.",
				"Spend the first morning in Estrela and Campo de Ourique. Both work well for a slower walk, cafés, and small shops. Continue to the riverside in the afternoon, then visit Graça near sunset if you feel like a hill walk. This keeps the first day flexible and reduces time in busy central queues.",
				"Set aside about €240 for food and €60 for transport for two people over three days. The food estimate assumes simple breakfasts, casual lunches, and one sit-down dinner each day. The transport estimate covers ordinary local trips with a small buffer. Check the current fare and ticket options before buying.",
				"Day 1: Estrela, Campo de Ourique, and an optional sunset walk in Graça. Estimate: €90 for food and transport.\n\nDay 2: Belém, the waterfront, and a café break. Estimate: €130 including attractions.\n\nDay 3: A neighborhood market, a museum, and an open afternoon. Estimate: €150 including food, transport, and activities.\n\nAccommodation: €420. Contingency: €50. Estimated total for two: €840, excluding flights.",
			},
			tool:      "search-destination-guides",
			toolType:  "RETRIEVER",
			toolInput: map[string]any{"destination": "Lisbon, Portugal", "days": 3, "travelers": 2, "budget_eur": 900, "pace": "relaxed"},
			toolData:  map[string]any{"neighborhoods": []string{"Estrela", "Campo de Ourique", "Belém", "Graça"}, "lodging_estimate_per_night_eur": 140, "food_estimate_daily_eur": 80, "currency": "EUR", "price_type": "planning_estimate"},
		},
		{
			name: "code-assistant",
			tags: []string{"engineering", "code-review"},
			questions: []string{
				"Review this Go handler for a possible goroutine leak when a client disconnects.",
				"How should the worker pass its result back if the request is canceled?",
				"Can we preserve the upstream timeout and still return a useful error?",
				"Summarize the changes needed before this handler is ready to merge.",
			},
			answers: []string{
				"The worker can remain blocked when it sends to the unbuffered result channel after the request handler returns. A client disconnect cancels the request context, but that does not automatically unblock a channel send.\n\nUse a buffered result channel with capacity one, or select between sending the result and the context cancellation signal. Pass the request context into the upstream call so that work stops when the client disconnects.",
				"For one worker and one result, a channel with capacity one is the smallest change. The worker can send its result even if the handler has already returned. Also pass the request context to the upstream operation. For several workers, select between the send and ctx.Done() so canceled requests do not leave blocked senders.",
				"Create the upstream timeout from the request context with context.WithTimeout and defer its cancel function. Handle context.DeadlineExceeded as a gateway timeout. If the parent request context is canceled because the client disconnected, stop work and avoid trying to write a response. Keep internal error details in the server log.",
				"Before merging:\n\n• Ensure the result send cannot block after the handler exits.\n• Pass the request context into the upstream call.\n• Cancel the timeout context on all paths.\n• Return a gateway timeout when the upstream deadline expires.\n• Keep internal error details out of the response body.\n\nThe main failure is a blocked channel send after request cancellation.",
			},
			tool:      "search-codebase",
			toolType:  "TOOL",
			toolInput: map[string]any{"repository": "acme/api-service", "query": "result channel request context handler", "language": "go"},
			toolData:  map[string]any{"matches": []map[string]any{{"path": "internal/api/search.go", "line": 42, "snippet": "result := make(chan Result)\ngo func() { result <- fetch(ctx, query) }()"}, {"path": "internal/client/search.go", "line": 18, "snippet": "func fetch(ctx context.Context, query string) Result"}}, "files_searched": 84},
		},
	}
	models := []string{"local/deepseek-v4-flash", "openai-codex/gpt-5.6-sol"}
	traces := make([]Trace, 0, 96)
	firstDay := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, -6)
	groupSpacing := (now.Sub(firstDay) - 2*time.Hour) / 23
	for group := 0; group < 24; group++ {
		sc := scenarios[group%len(scenarios)]
		model := models[group%len(models)]
		environment := "production"
		if group%9 == 5 {
			environment = "staging"
		} else if group%11 == 8 {
			environment = "development"
		}
		sessionID := "session-" + seedID(fmt.Sprintf("session-%d", group))[:12]
		userID := fmt.Sprintf("user_%s", seedID(fmt.Sprintf("user-%d", group%18))[:8])
		for turn := 0; turn < 4; turn++ {
			i := group*4 + turn
			stamp := now.Add(-time.Duration(group)*groupSpacing - time.Duration(6+turn*3)*time.Minute)
			id := seedID(fmt.Sprintf("trace-%d", i))
			latency := round(1.14+float64((i*37)%690)/100, 3)
			inputTokens := 1250 + (i*193)%6400
			outputTokens := 220 + (i*71)%1150
			level := "DEFAULT"
			output := sc.answers[3-turn]
			if i == 14 || i == 37 || i == 69 || i == 87 {
				level = "ERROR"
				latency = round(10+float64(i%7)/10, 3)
				output = "The upstream service did not respond within the configured timeout. The request has been recorded for retry. Please try again in a moment."
				outputTokens = 48
			} else if i%17 == 9 {
				level = "WARNING"
				latency += 3.1
			}
			input := sc.questions[3-turn]
			cost := tokenCost(model, inputTokens, outputTokens)
			trace := Trace{
				ID: id, Name: sc.name, Timestamp: stamp.Format(time.RFC3339Nano), Environment: environment,
				UserID: userID, SessionID: sessionID, Latency: latency, TotalTokens: inputTokens + outputTokens,
				InputTokens: inputTokens, OutputTokens: outputTokens, Cost: cost, Level: level,
				Tags: append([]string{}, sc.tags...), Bookmarked: i == 0 || i == 8 || i == 14 || i == 29,
				Input: input, Output: output, Model: model, Version: "1.4.2",
				Metadata: map[string]any{"sdk": "elune-python", "sdkVersion": "3.2.1", "release": "2026.09.28", "region": "us-east-1", "conversationTurn": 4 - turn, "deployment": "agents-prod", "sampleData": true},
				Scores:   []Score{}, Observations: []Observation{},
			}
			trace.Observations = seedObservations(trace, sc, i)
			if i%7 != 4 {
				value := round(0.82+float64((i*7)%18)/100, 2)
				comment := "The response addresses the request and is supported by the retrieved context."
				if level == "ERROR" {
					value = 0.18
					comment = "The upstream timeout prevented the agent from completing the request."
				} else if level == "WARNING" {
					value = 0.72
					comment = "The answer is useful, but retrieval required a retry and increased latency."
				}
				trace.Scores = append(trace.Scores, Score{ID: "score-" + seedID(fmt.Sprintf("score-quality-%d", i))[:16], TraceID: id, TraceName: sc.name, Name: "quality", Value: value, Comment: comment, Source: "EVAL", Timestamp: stamp.Add(time.Duration(latency+1) * time.Second).Format(time.RFC3339Nano), DataType: "NUMERIC"})
			}
			if i%3 == 0 {
				value := 1.0
				if level == "ERROR" {
					value = 0
				}
				trace.Scores = append(trace.Scores, Score{ID: "score-" + seedID(fmt.Sprintf("score-helpful-%d", i))[:16], TraceID: id, TraceName: sc.name, Name: "helpfulness", Value: value, Comment: "Feedback collected from the conversation review.", Source: "ANNOTATION", Timestamp: stamp.Add(3 * time.Minute).Format(time.RFC3339Nano), DataType: "BOOLEAN"})
			}
			traces = append(traces, trace)
		}
	}
	sort.Slice(traces, func(i, j int) bool { return traces[i].Timestamp > traces[j].Timestamp })
	return traces
}

func seedObservations(t Trace, sc scenario, index int) []Observation {
	rootID := "obs-" + seedID(t.ID + "root")[:16]
	contextID := "obs-" + seedID(t.ID + "context")[:16]
	retrievalID := "obs-" + seedID(t.ID + "retrieval")[:16]
	contextInput := pretty(map[string]any{"sessionId": t.SessionID, "userId": t.UserID, "message": t.Input})
	contextOutput := pretty(map[string]any{"history_messages": 2 * (4 - index%4), "context_tokens": 420 + index*11, "system_prompt": "You are a helpful assistant. Use available tools, ground answers in source material, and state uncertainty when evidence is incomplete."})
	routeInput := t.Input
	routeOutput := pretty(map[string]any{"intent": sc.name, "tool": sc.tool, "requires_retrieval": true, "confidence": 0.97})
	toolOutput := pretty(sc.toolData)
	toolLevel := "DEFAULT"
	if t.Level == "ERROR" {
		toolLevel = "ERROR"
		toolOutput = pretty(map[string]any{"error": "UPSTREAM_TIMEOUT", "message": "The upstream service exceeded the 10 second deadline.", "retryable": true, "attempts": 2})
	} else if t.Level == "WARNING" {
		toolLevel = "WARNING"
	}
	routeIn := t.InputTokens / 6
	routeOut := t.OutputTokens / 8
	answerInput := pretty(map[string]any{"messages": []map[string]string{{"role": "system", "content": "Answer the user's question using the retrieved context. Be concise, cite evidence when available, and do not invent missing facts."}, {"role": "user", "content": t.Input}}, "context": toolOutput, "temperature": 0.2, "max_tokens": 2048})
	observations := []Observation{
		{ID: rootID, Name: t.Name, Type: "AGENT", StartTime: 0, Duration: t.Latency, Level: t.Level, Input: t.Input, Output: t.Output, Metadata: map[string]any{"framework": "LangGraph", "graph": t.Name, "version": t.Version}},
		{ID: contextID, ParentID: &rootID, Name: "prepare-context", Type: "SPAN", StartTime: round(t.Latency*0.01, 3), Duration: round(t.Latency*0.07, 3), Level: "DEFAULT", Input: contextInput, Output: contextOutput, Metadata: map[string]any{"cache_hit": index%3 != 1}},
		{ID: "obs-" + seedID(t.ID + "route")[:16], ParentID: &rootID, Name: "classify-intent", Type: "GENERATION", StartTime: round(t.Latency*0.1, 3), Duration: round(t.Latency*0.15, 3), Level: "DEFAULT", Model: t.Model, Input: routeInput, Output: routeOutput, InputTokens: routeIn, OutputTokens: routeOut, Cost: tokenCost(t.Model, routeIn, routeOut), Metadata: map[string]any{"temperature": 0, "finish_reason": "stop"}},
		{ID: retrievalID, ParentID: &rootID, Name: sc.tool, Type: sc.toolType, StartTime: round(t.Latency*0.27, 3), Duration: round(t.Latency*0.22, 3), Level: toolLevel, Input: pretty(sc.toolInput), Output: toolOutput, Metadata: map[string]any{"attempts": 1 + boolInt(toolLevel != "DEFAULT"), "timeout_ms": 10000}},
		{ID: "obs-" + seedID(t.ID + "source")[:16], ParentID: &retrievalID, Name: "fetch-source-context", Type: "SPAN", StartTime: round(t.Latency*0.29, 3), Duration: round(t.Latency*0.17, 3), Level: toolLevel, Input: pretty(sc.toolInput), Output: toolOutput, Metadata: map[string]any{"cache_hit": index%4 == 0, "source_count": 2}},
		{ID: "obs-" + seedID(t.ID + "generate")[:16], ParentID: &rootID, Name: "generate-response", Type: "GENERATION", StartTime: round(t.Latency*0.52, 3), Duration: round(t.Latency*0.45, 3), Level: "DEFAULT", Model: t.Model, Input: answerInput, Output: t.Output, InputTokens: t.InputTokens - routeIn, OutputTokens: t.OutputTokens - routeOut, Cost: round(t.Cost-tokenCost(t.Model, routeIn, routeOut), 8), Metadata: map[string]any{"temperature": 0.2, "max_tokens": 2048, "finish_reason": "stop", "time_to_first_token_ms": 142 + index*3}},
		{ID: "obs-" + seedID(t.ID + "validate")[:16], ParentID: &rootID, Name: "validate-output", Type: "SPAN", StartTime: round(t.Latency*0.98, 3), Duration: round(t.Latency*0.015, 3), Level: "DEFAULT", Input: t.Output, Output: pretty(map[string]any{"passed": true, "checks": []string{"pii", "format", "groundedness"}}), Metadata: map[string]any{"validator": "output-policy-v2"}},
	}
	return observations
}

func seedID(s string) string {
	h := sha256.Sum256([]byte("elune:" + s))
	return hex.EncodeToString(h[:16])
}

func pretty(v any) string {
	b, _ := json.MarshalIndent(v, "", "  ")
	return string(b)
}

func round(v float64, digits int) float64 {
	scale := math.Pow10(digits)
	return math.Round(v*scale) / scale
}

func tokenCost(model string, input, output int) float64 {
	inRate, outRate := 2.0, 8.0
	if model == "local/deepseek-v4-flash" {
		inRate, outRate = 0, 0
	}
	return round((float64(input)*inRate+float64(output)*outRate)/1_000_000, 8)
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
