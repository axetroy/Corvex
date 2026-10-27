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
	endpoint         string
	apiKey           string
	model            string
	maxTokens        int
	tokenBudget      TokenBudget
	dailyTokenBudget int64
	httpClient       *http.Client
}

type TokenBudget interface {
	ReserveModelTokens(context.Context, int64, int64) (string, error)
	SettleModelTokens(context.Context, string, int64, int64) error
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
	return NewClientWithMaxTokens(baseURL, apiKey, model, timeout, 4096)
}

func NewClientWithMaxTokens(baseURL, apiKey, model string, timeout time.Duration, maxTokens int) (*Client, error) {
	return NewClientWithTokenBudget(baseURL, apiKey, model, timeout, maxTokens, nil, 0)
}

func NewClientWithTokenBudget(
	baseURL, apiKey, model string,
	timeout time.Duration,
	maxTokens int,
	budget TokenBudget,
	dailyTokenBudget int64,
) (*Client, error) {
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
	if maxTokens <= 0 || maxTokens > 8192 {
		return nil, errors.New("model max output tokens must be between 1 and 8192")
	}
	if dailyTokenBudget < 0 {
		return nil, errors.New("daily model token budget must not be negative")
	}
	if dailyTokenBudget > 0 && budget == nil {
		return nil, errors.New("daily model token budget requires a persistent budget store")
	}
	return &Client{
		endpoint: strings.TrimRight(baseURL, "/") + "/chat/completions",
		apiKey:   apiKey, model: model,
		maxTokens:   maxTokens,
		tokenBudget: budget, dailyTokenBudget: dailyTokenBudget,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}, nil
}

func (c *Client) Generate(ctx context.Context, request ModelRequest) (result ModelResponse, resultErr error) {
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
		MaxTokens:   c.maxTokens,
	})
	if err != nil {
		return ModelResponse{}, fmt.Errorf("encode model request: %w", err)
	}
	if len(payload) > maxPromptBytes {
		return ModelResponse{}, fmt.Errorf("model request exceeds %d-byte limit", maxPromptBytes)
	}
	var budgetDay string
	reservedTokens := int64(len(request.SystemPrompt) + len(request.UserPrompt) + c.maxTokens)
	if c.dailyTokenBudget > 0 {
		budgetDay, err = c.tokenBudget.ReserveModelTokens(ctx, c.dailyTokenBudget, reservedTokens)
		if err != nil {
			return ModelResponse{}, fmt.Errorf("reserve daily model token budget: %w", err)
		}
		defer func() {
			actualTokens := reservedTokens
			if resultErr == nil && result.Usage.TotalTokens > 0 {
				actualTokens = int64(result.Usage.TotalTokens)
			}
			settleCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := c.tokenBudget.SettleModelTokens(settleCtx, budgetDay, reservedTokens, actualTokens); err != nil {
				resultErr = errors.Join(resultErr, fmt.Errorf("settle daily model token budget: %w", err))
			}
		}()
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
