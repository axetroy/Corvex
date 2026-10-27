package agent

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGenerateUsesOpenAICompatibleChatAPI(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Method != http.MethodPost {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer model-secret" {
			t.Error("model API key header missing")
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(body), `"model":"review-model"`) ||
			!strings.Contains(string(body), `"role":"system"`) ||
			!strings.Contains(string(body), `"role":"user"`) ||
			!strings.Contains(string(body), `"max_tokens":1234`) {
			t.Errorf("unexpected request body: %s", body)
		}
		_, _ = io.WriteString(w, `{"model":"review-model","choices":[{"finish_reason":"stop","message":{"content":"{\"summary\":\"ok\",\"findings\":[]}"}}],"usage":{"prompt_tokens":12,"completion_tokens":9,"total_tokens":21}}`)
	}))
	defer server.Close()

	client, err := NewClientWithMaxTokens(server.URL+"/v1", "model-secret", "review-model", time.Second, 1234)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Generate(context.Background(), ModelRequest{
		SystemPrompt: "Review only.",
		UserPrompt:   `{"diff":"untrusted code"}`,
	})
	if err != nil {
		t.Fatalf("Generate() error = %v", err)
	}
	if response.Usage.TotalTokens != 21 || !strings.Contains(response.Content, `"findings"`) {
		t.Fatalf("unexpected model response: %#v", response)
	}
}

func TestNewClientWithMaxTokensRejectsUnboundedLimits(t *testing.T) {
	for _, maxTokens := range []int{0, -1, 8193} {
		if _, err := NewClientWithMaxTokens("https://example.test/v1", "key", "model", time.Second, maxTokens); err == nil {
			t.Errorf("NewClientWithMaxTokens(..., %d) unexpectedly succeeded", maxTokens)
		}
	}
}

func TestGenerateReservesAndSettlesDailyTokenBudget(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"model":"review-model","choices":[{"finish_reason":"stop","message":{"content":"ok"}}],"usage":{"prompt_tokens":12,"completion_tokens":9,"total_tokens":21}}`)
	}))
	defer server.Close()
	budget := &fakeTokenBudget{}
	client, err := NewClientWithTokenBudget(server.URL, "key", "model", time.Second, 64, budget, 1000)
	if err != nil {
		t.Fatal(err)
	}
	request := ModelRequest{SystemPrompt: "Explain.", UserPrompt: "A small prompt."}
	if _, err := client.Generate(context.Background(), request); err != nil {
		t.Fatalf("Generate() error = %v", err)
	}
	wantReservation := int64(len(request.SystemPrompt) + len(request.UserPrompt) + 64)
	if budget.reserved != wantReservation || budget.settled != 21 {
		t.Fatalf("budget reservation/settlement = %d/%d, want %d/21",
			budget.reserved, budget.settled, wantReservation)
	}
}

func TestGenerateRejectsRequestWhenDailyBudgetIsExhausted(t *testing.T) {
	budget := &fakeTokenBudget{reserveErr: errors.New("budget exhausted")}
	client, err := NewClientWithTokenBudget("https://example.test/v1", "key", "model",
		time.Second, 64, budget, 10)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Generate(context.Background(), ModelRequest{SystemPrompt: "Explain.", UserPrompt: "prompt"})
	if err == nil || !strings.Contains(err.Error(), "reserve daily model token budget") {
		t.Fatalf("Generate() error = %v, want budget rejection", err)
	}
	if budget.settleCalled {
		t.Fatal("budget settlement ran without a successful reservation")
	}
}

func TestNewClientRejectsUnsafeOrIncompleteConfiguration(t *testing.T) {
	for _, test := range []struct {
		baseURL string
		apiKey  string
		model   string
	}{
		{baseURL: "https://user:pass@example.test/v1", apiKey: "key", model: "model"},
		{baseURL: "https://example.test/v1", apiKey: "", model: "model"},
		{baseURL: "https://example.test/v1", apiKey: "key", model: ""},
	} {
		if _, err := NewClient(test.baseURL, test.apiKey, test.model, time.Second); err == nil {
			t.Errorf("NewClient(%q, %q, %q) unexpectedly succeeded", test.baseURL, test.apiKey, test.model)
		}
	}
}

func TestGenerateRejectsOversizedPrompt(t *testing.T) {
	client, err := NewClient("https://model.example.test/v1", "key", "model", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Generate(context.Background(), ModelRequest{
		SystemPrompt: "Review",
		UserPrompt:   strings.Repeat("x", maxPromptBytes),
	})
	if err == nil {
		t.Fatal("Generate accepted an oversized prompt")
	}
}

type fakeTokenBudget struct {
	reserved     int64
	settled      int64
	reserveErr   error
	settleErr    error
	settleCalled bool
}

func (f *fakeTokenBudget) ReserveModelTokens(_ context.Context, _, tokens int64) (string, error) {
	f.reserved = tokens
	return "2026-10-27", f.reserveErr
}

func (f *fakeTokenBudget) SettleModelTokens(_ context.Context, _ string, _, actual int64) error {
	f.settleCalled = true
	f.settled = actual
	return f.settleErr
}
