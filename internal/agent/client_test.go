package agent

import (
	"context"
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
			!strings.Contains(string(body), `"role":"user"`) {
			t.Errorf("unexpected request body: %s", body)
		}
		_, _ = io.WriteString(w, `{"model":"review-model","choices":[{"finish_reason":"stop","message":{"content":"{\"summary\":\"ok\",\"findings\":[]}"}}],"usage":{"prompt_tokens":12,"completion_tokens":9,"total_tokens":21}}`)
	}))
	defer server.Close()

	client, err := NewClient(server.URL+"/v1", "model-secret", "review-model", time.Second)
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
