package app

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/axetroy/corvex/internal/config"
	"github.com/axetroy/corvex/internal/gitlab"
	"github.com/axetroy/corvex/internal/jobs"
)

func TestWebhookQueuesAndDeduplicatesReview(t *testing.T) {
	var postedNotes int
	gitlabAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v4/projects/10/merge_requests/5/notes" {
			t.Errorf("unexpected GitLab request: %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("PRIVATE-TOKEN") != "api-token" {
			t.Error("GitLab API token header missing")
		}
		postedNotes++
		w.WriteHeader(http.StatusCreated)
	}))
	defer gitlabAPI.Close()

	store, err := jobs.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	client, err := gitlab.NewClient(gitlabAPI.URL, "api-token")
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		Server: config.ServerConfig{Listen: "127.0.0.1:0", ReadTimeout: DurationForTest(5 * time.Second)},
		GitLab: config.GitLabConfig{
			BaseURL: gitlabAPI.URL, WebhookSecret: "webhook-secret",
			AllowedProjectIDs: []int64{10}, AllowedUserIDs: []int64{42},
		},
	}
	server := NewServer(cfg, store, client, slog.New(slog.NewTextHandler(testWriter{t}, nil)))

	payload := `{"object_kind":"note","user":{"id":42,"username":"developer"},"project":{"id":10},"object_attributes":{"id":123,"note":"@corvex review","noteable_type":"MergeRequest"},"merge_request":{"iid":5,"last_commit":{"id":"0123456789abcdef"}}}`
	for attempt := 0; attempt < 2; attempt++ {
		req := httptest.NewRequest(http.MethodPost, "/webhooks/gitlab", strings.NewReader(payload))
		req.Header.Set("X-Gitlab-Token", "webhook-secret")
		req.Header.Set("X-Gitlab-Event", "Note Hook")
		res := httptest.NewRecorder()
		server.Handler().ServeHTTP(res, req)
		if res.Code != http.StatusAccepted {
			t.Fatalf("webhook status = %d, want %d (body: %s)", res.Code, http.StatusAccepted, res.Body)
		}
	}
	if postedNotes != 1 {
		t.Fatalf("posted note count = %d, want 1 after duplicate delivery", postedNotes)
	}
}

func TestWebhookRejectsInvalidTokenBeforeParsing(t *testing.T) {
	store, err := jobs.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	client, err := gitlab.NewClient("https://gitlab.example.test", "token")
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{GitLab: config.GitLabConfig{WebhookSecret: "expected"}}
	server := NewServer(cfg, store, client, slog.New(slog.NewTextHandler(testWriter{t}, nil)))
	req := httptest.NewRequest(http.MethodPost, "/webhooks/gitlab", strings.NewReader("not json"))
	req.Header.Set("X-Gitlab-Token", "wrong")
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusUnauthorized)
	}
}

func TestFixCommandRequiresDedicatedAuthorizationAndNeverQueues(t *testing.T) {
	for _, test := range []struct {
		name        string
		enabled     bool
		fixUsers    []int64
		wantMessage string
	}{
		{name: "disabled", wantMessage: "disabled by configuration"},
		{name: "not allowlisted", enabled: true, fixUsers: []int64{99}, wantMessage: "not authorized"},
		{name: "authorized but unavailable", enabled: true, fixUsers: []int64{42}, wantMessage: "No task was queued"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var postedBodies []string
			gitlabAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if err := r.ParseForm(); err != nil {
					t.Errorf("parse GitLab note form: %v", err)
					http.Error(w, "bad form", http.StatusBadRequest)
					return
				}
				postedBodies = append(postedBodies, r.Form.Get("body"))
				w.WriteHeader(http.StatusCreated)
			}))
			defer gitlabAPI.Close()

			store, err := jobs.Open(":memory:")
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			client, err := gitlab.NewClient(gitlabAPI.URL, "api-token")
			if err != nil {
				t.Fatal(err)
			}
			server := NewServer(config.Config{
				GitLab: config.GitLabConfig{
					BaseURL: gitlabAPI.URL, WebhookSecret: "secret",
					AllowedProjectIDs: []int64{10}, AllowedUserIDs: []int64{42},
				},
				Fix: config.FixConfig{Enabled: test.enabled, AllowedUserIDs: test.fixUsers},
			}, store, client, slog.New(slog.NewTextHandler(testWriter{t}, nil)))

			payload := `{"object_kind":"note","user":{"id":42,"username":"developer"},"project":{"id":10},"object_attributes":{"id":100,"note":"@corvex fix","noteable_type":"MergeRequest"},"merge_request":{"iid":5}}`
			req := httptest.NewRequest(http.MethodPost, "/webhooks/gitlab", strings.NewReader(payload))
			req.Header.Set("X-Gitlab-Token", "secret")
			req.Header.Set("X-Gitlab-Event", "Note Hook")
			res := httptest.NewRecorder()
			server.Handler().ServeHTTP(res, req)
			if res.Code != http.StatusAccepted {
				t.Fatalf("webhook status = %d, want %d (body: %s)", res.Code, http.StatusAccepted, res.Body)
			}
			if len(postedBodies) != 1 || !strings.Contains(postedBodies[0], test.wantMessage) {
				t.Fatalf("response notes = %q, want one containing %q", postedBodies, test.wantMessage)
			}
			status, err := store.Status(context.Background(), "status-check", 10, 5, 42)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(status.Response, "No Corvex task has been created") {
				t.Fatalf("fix authorization unexpectedly queued a job: %q", status.Response)
			}
		})
	}
}

func TestReadinessChecksDatabase(t *testing.T) {
	store, err := jobs.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	client, err := gitlab.NewClient("https://gitlab.example.test", "token")
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(config.Config{}, store, client, slog.Default())
	req := httptest.NewRequest(http.MethodGet, "/readyz", nil).WithContext(context.Background())
	res := httptest.NewRecorder()
	server.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", res.Code, http.StatusOK)
	}
}

type testWriter struct{ t *testing.T }

func (w testWriter) Write(data []byte) (int, error) {
	var entry map[string]any
	if err := json.Unmarshal(data, &entry); err != nil {
		w.t.Errorf("invalid log JSON: %v", err)
	}
	return len(data), nil
}

func DurationForTest(value time.Duration) config.Duration {
	return config.Duration(value)
}
