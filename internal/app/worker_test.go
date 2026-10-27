package app

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/axetroy/corvex/internal/agent"
	"github.com/axetroy/corvex/internal/config"
	"github.com/axetroy/corvex/internal/git"
	"github.com/axetroy/corvex/internal/gitlab"
	"github.com/axetroy/corvex/internal/jobs"
	"github.com/axetroy/corvex/internal/review"
)

func TestWorkerProcessesQueuedReviewAtPinnedHead(t *testing.T) {
	headSHA := strings.Repeat("b", 40)
	baseSHA := strings.Repeat("a", 40)
	store, jobID := queuedReviewJob(t, headSHA)
	defer store.Close()
	api := &fakeGitLab{
		mergeRequest: gitlab.MergeRequest{
			IID: 8, State: "opened", Title: "Feature", SourceBranch: "feature", TargetBranch: "main",
			DiffRefs: struct {
				BaseSHA  string `json:"base_sha"`
				StartSHA string `json:"start_sha"`
				HeadSHA  string `json:"head_sha"`
			}{BaseSHA: baseSHA, HeadSHA: headSHA},
		},
		project: gitlab.Project{ID: 10, HTTPURLToRepo: "https://gitlab.example.test/p.git"},
	}
	repository := &fakeRepository{headSHA: headSHA, baseSHA: baseSHA}
	reviewer := &fakeReviewer{outcome: review.Outcome{
		Result: review.Result{
			Summary: "Concrete bug found.",
			Findings: []review.Finding{{
				Severity: "high", Title: "@all can panic", FilePath: "main.go", Line: 2,
				Evidence: "if value == nil", Explanation: "The value is dereferenced on this path.",
			}},
		},
		Model: "review-model", Usage: agent.ModelUsage{TotalTokens: 25},
	}}
	worker := newTestWorker(t, store, api, repository, reviewer)

	worked, err := worker.processNext(context.Background())
	if err != nil {
		t.Fatalf("processNext() error = %v", err)
	}
	if !worked || !repository.cleaned || reviewer.calls != 1 || len(api.notes) != 1 {
		t.Fatalf("review did not complete: worked=%t cleaned=%t reviewCalls=%d notes=%d",
			worked, repository.cleaned, reviewer.calls, len(api.notes))
	}
	if strings.Contains(api.notes[0], "@all") || !strings.Contains(api.notes[0], "&#64;all") {
		t.Fatalf("review comment did not neutralize mentions: %s", api.notes[0])
	}
	job, err := store.GetJob(context.Background(), jobID)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != jobs.StatusCompleted || job.AttemptCount != 1 {
		t.Fatalf("unexpected completed job: %#v", job)
	}
}

func TestWorkerMarksChangedMRStaleWithoutPreparingWorkspace(t *testing.T) {
	headSHA := strings.Repeat("b", 40)
	store, jobID := queuedReviewJob(t, headSHA)
	defer store.Close()
	api := &fakeGitLab{
		mergeRequest: gitlab.MergeRequest{
			IID: 8, State: "opened",
			DiffRefs: struct {
				BaseSHA  string `json:"base_sha"`
				StartSHA string `json:"start_sha"`
				HeadSHA  string `json:"head_sha"`
			}{BaseSHA: strings.Repeat("a", 40), HeadSHA: strings.Repeat("c", 40)},
		},
	}
	repository := &fakeRepository{}
	reviewer := &fakeReviewer{}
	worker := newTestWorker(t, store, api, repository, reviewer)

	worked, err := worker.processNext(context.Background())
	if err != nil {
		t.Fatalf("processNext() error = %v", err)
	}
	if !worked || repository.prepared || reviewer.calls != 0 || len(api.notes) != 1 {
		t.Fatalf("stale job was not stopped: worked=%t prepared=%t modelCalls=%d notes=%d",
			worked, repository.prepared, reviewer.calls, len(api.notes))
	}
	job, err := store.GetJob(context.Background(), jobID)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != jobs.StatusStale {
		t.Fatalf("job status = %s, want stale", job.Status)
	}
}

func TestWorkerFailsTaskWhenPublishingFails(t *testing.T) {
	headSHA := strings.Repeat("b", 40)
	baseSHA := strings.Repeat("a", 40)
	store, jobID := queuedReviewJob(t, headSHA)
	defer store.Close()
	api := &fakeGitLab{
		mergeRequest: gitlab.MergeRequest{
			IID: 8, State: "opened",
			DiffRefs: struct {
				BaseSHA  string `json:"base_sha"`
				StartSHA string `json:"start_sha"`
				HeadSHA  string `json:"head_sha"`
			}{BaseSHA: baseSHA, HeadSHA: headSHA},
		},
		project: gitlab.Project{ID: 10, HTTPURLToRepo: "https://gitlab.example.test/p.git"},
		postErr: errors.New("GitLab unavailable"),
	}
	repository := &fakeRepository{headSHA: headSHA, baseSHA: baseSHA}
	reviewer := &fakeReviewer{outcome: review.Outcome{Result: review.Result{Summary: "No issues."}}}
	worker := newTestWorker(t, store, api, repository, reviewer)

	worked, err := worker.processNext(context.Background())
	if !worked || err == nil {
		t.Fatalf("processNext() = (%t, %v), want a processed task and error", worked, err)
	}
	job, err := store.GetJob(context.Background(), jobID)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != jobs.StatusFailed || job.LastError == "" {
		t.Fatalf("publishing failure was not stored: %#v", job)
	}
}

func TestWorkerDoesNotPublishWhenMRChangesDuringReview(t *testing.T) {
	headSHA := strings.Repeat("b", 40)
	baseSHA := strings.Repeat("a", 40)
	store, jobID := queuedReviewJob(t, headSHA)
	defer store.Close()
	api := &fakeGitLab{
		mergeRequests: []gitlab.MergeRequest{
			{
				IID: 8, State: "opened",
				DiffRefs: struct {
					BaseSHA  string `json:"base_sha"`
					StartSHA string `json:"start_sha"`
					HeadSHA  string `json:"head_sha"`
				}{BaseSHA: baseSHA, HeadSHA: headSHA},
			},
			{
				IID: 8, State: "opened",
				DiffRefs: struct {
					BaseSHA  string `json:"base_sha"`
					StartSHA string `json:"start_sha"`
					HeadSHA  string `json:"head_sha"`
				}{BaseSHA: baseSHA, HeadSHA: strings.Repeat("c", 40)},
			},
		},
		project: gitlab.Project{ID: 10, HTTPURLToRepo: "https://gitlab.example.test/p.git"},
	}
	repository := &fakeRepository{}
	reviewer := &fakeReviewer{outcome: review.Outcome{Result: review.Result{Summary: "Review finished."}}}
	worker := newTestWorker(t, store, api, repository, reviewer)

	worked, err := worker.processNext(context.Background())
	if err != nil {
		t.Fatalf("processNext() error = %v", err)
	}
	if !worked || reviewer.calls != 1 || len(api.notes) != 1 ||
		!strings.Contains(api.notes[0], "changed while the review was running") {
		t.Fatalf("stale result was published or not reported: worked=%t reviewCalls=%d notes=%v",
			worked, reviewer.calls, api.notes)
	}
	job, err := store.GetJob(context.Background(), jobID)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != jobs.StatusStale {
		t.Fatalf("job status = %s, want stale", job.Status)
	}
}

func queuedReviewJob(t *testing.T, headSHA string) (*jobs.Store, string) {
	t.Helper()
	store, err := jobs.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	result, err := store.CreateReview(context.Background(), "note-1", "key-1", jobs.Job{
		ProjectID: 10, MRIID: 8, HeadSHA: headSHA, ActorID: 99,
	})
	if err != nil {
		store.Close()
		t.Fatal(err)
	}
	parts := strings.Split(result.Response, "`")
	if len(parts) < 2 {
		store.Close()
		t.Fatalf("could not parse queued job ID from %q", result.Response)
	}
	return store, parts[1]
}

func newTestWorker(
	t *testing.T,
	store *jobs.Store,
	api *fakeGitLab,
	repository *fakeRepository,
	reviewer *fakeReviewer,
) *Worker {
	t.Helper()
	worker, err := NewWorker(config.Config{
		Agent:  config.AgentConfig{Enabled: true},
		Review: config.ReviewConfig{MaxFiles: 50, MaxFindings: 10, MaxContextBytes: 1 << 20},
		Worker: config.WorkerConfig{PollInterval: config.Duration(time.Second), JobTimeout: config.Duration(time.Minute)},
	}, store, api, repository, reviewer, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return worker
}

type fakeGitLab struct {
	mergeRequest  gitlab.MergeRequest
	mergeRequests []gitlab.MergeRequest
	mergeCalls    int
	project       gitlab.Project
	notes         []string
	postErr       error
}

func (f *fakeGitLab) GetProject(context.Context, int64) (gitlab.Project, error) {
	return f.project, nil
}

func (f *fakeGitLab) GetMergeRequest(context.Context, int64, int64) (gitlab.MergeRequest, error) {
	if len(f.mergeRequests) > 0 {
		index := f.mergeCalls
		f.mergeCalls++
		if index >= len(f.mergeRequests) {
			index = len(f.mergeRequests) - 1
		}
		return f.mergeRequests[index], nil
	}
	return f.mergeRequest, nil
}

func (f *fakeGitLab) PostNote(_ context.Context, _, _ int64, body string) error {
	f.notes = append(f.notes, body)
	return f.postErr
}

type fakeRepository struct {
	headSHA  string
	baseSHA  string
	prepared bool
	cleaned  bool
}

func (f *fakeRepository) PrepareWorkspace(
	_ context.Context, projectID int64, jobID, _, headSHA string,
) (git.Workspace, error) {
	f.prepared = true
	f.headSHA = headSHA
	return git.Workspace{
		ProjectID: projectID, JobID: jobID, Path: "/fake/workspaces/" + jobID, HeadSHA: headSHA,
	}, nil
}

func (f *fakeRepository) Diff(
	_ context.Context, workspace git.Workspace, baseSHA string, _, _ int,
) (git.DiffResult, error) {
	f.baseSHA = baseSHA
	return git.DiffResult{
		BaseSHA: baseSHA, HeadSHA: workspace.HeadSHA,
		Changes: []git.Change{{
			Path: "main.go", Status: "M",
			Patch: "@@ -1,2 +1,3 @@\n package sample\n+if value == nil { return 0 }\n return value\n",
		}},
	}, nil
}

func (f *fakeRepository) CleanupWorkspace(context.Context, git.Workspace) error {
	f.cleaned = true
	return nil
}

type fakeReviewer struct {
	outcome review.Outcome
	calls   int
}

func (f *fakeReviewer) Review(context.Context, review.Context, git.DiffResult) (review.Outcome, error) {
	f.calls++
	return f.outcome, nil
}
