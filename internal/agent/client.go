package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	maxPromptBytes   = 8 << 20
	maxResponseBytes = 2 << 20
)

type Client struct {
	endpoint   string
	apiKey     string
	model      string
	httpClient *http.Client
}

type ModelRequest struct {
	SystemPrompt string
	UserPrompt   string
}

type ModelUsage struct {
	InputTokens  int `json:"prompt_tokens"`
	OutputTokens int `json:"completion_tokens"`
	TotalTokens  int `json:"total_tokens"`
}

type ModelResponse struct {
	Content string
	Model   string
	Usage   ModelUsage
}

type chatCompletionRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
	MaxTokens   int           `json:"max_tokens"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatCompletionResponse struct {
	Model   string `json:"model"`
	Choices []struct {
		FinishReason string `json:"finish_reason"`
		Message      struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Usage ModelUsage `json:"usage"`
}

func NewClient(baseURL, apiKey, model string, timeout time.Duration) (*Client, error) {
	parsed, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" ||
		parsed.ForceQuery || parsed.Fragment != "" || parsed.RawFragment != "" ||
		(parsed.Scheme != "https" && parsed.Scheme != "http") {
		return nil, errors.New("model base URL must be a valid HTTP(S) URL without credentials")
	}
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("model API key is required")
	}
	if strings.TrimSpace(model) == "" {
		return nil, errors.New("model name is required")
	}
	if timeout <= 0 {
		return nil, errors.New("model request timeout must be positive")
	}
	return &Client{
		endpoint: strings.TrimRight(baseURL, "/") + "/chat/completions",
		apiKey:   apiKey,
		model:    model,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}, nil
}

func (c *Client) Generate(ctx context.Context, request ModelRequest) (ModelResponse, error) {
	if strings.TrimSpace(request.SystemPrompt) == "" || strings.TrimSpace(request.UserPrompt) == "" {
		return ModelResponse{}, errors.New("system and user prompts are required")
	}
	payload, err := json.Marshal(chatCompletionRequest{
		Model: c.model,
		Messages: []chatMessage{
			{Role: "system", Content: request.SystemPrompt},
			{Role: "user", Content: request.UserPrompt},
		},
		Temperature: 0,
		MaxTokens:   4096,
	})
	if err != nil {
		return ModelResponse{}, fmt.Errorf("encode model request: %w", err)
	}
	if len(payload) > maxPromptBytes {
		return ModelResponse{}, fmt.Errorf("model request exceeds %d-byte limit", maxPromptBytes)
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(payload))
	if err != nil {
		return ModelResponse{}, fmt.Errorf("create model request: %w", err)
	}
	httpRequest.Header.Set("Authorization", "Bearer "+c.apiKey)
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("Accept", "application/json")

	httpResponse, err := c.httpClient.Do(httpRequest)
	if err != nil {
		return ModelResponse{}, fmt.Errorf("send model request: %w", err)
	}
	defer httpResponse.Body.Close()
	if httpResponse.StatusCode < 200 || httpResponse.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(httpResponse.Body, 4<<10))
		return ModelResponse{}, fmt.Errorf("model API returned %s", httpResponse.Status)
	}
	body, err := io.ReadAll(io.LimitReader(httpResponse.Body, maxResponseBytes+1))
	if err != nil {
		return ModelResponse{}, fmt.Errorf("read model response: %w", err)
	}
	if len(body) > maxResponseBytes {
		return ModelResponse{}, fmt.Errorf("model response exceeds %d-byte limit", maxResponseBytes)
	}
	var response chatCompletionResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return ModelResponse{}, fmt.Errorf("decode model response: %w", err)
	}
	if len(response.Choices) == 0 {
		return ModelResponse{}, errors.New("model API returned no completion choices")
	}
	choice := response.Choices[0]
	if choice.FinishReason == "content_filter" {
		return ModelResponse{}, errors.New("model API blocked the completion")
	}
	if strings.TrimSpace(choice.Message.Content) == "" {
		return ModelResponse{}, errors.New("model API returned empty completion content")
	}
	if response.Usage.InputTokens < 0 || response.Usage.OutputTokens < 0 || response.Usage.TotalTokens < 0 {
		return ModelResponse{}, errors.New("model API returned invalid token usage")
	}
	return ModelResponse{Content: choice.Message.Content, Model: response.Model, Usage: response.Usage}, nil
}
