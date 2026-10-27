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
	"github.com/axetroy/corvex/internal/fix"
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
			}{BaseSHA: baseSHA, StartSHA: strings.Repeat("c", 40), HeadSHA: headSHA},
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

	if !worked || !repository.cleaned || reviewer.calls != 1 || len(api.notes) != 1 || len(api.discussions) != 1 {
		t.Fatalf("review did not complete: worked=%t cleaned=%t reviewCalls=%d notes=%d discussions=%d",
			worked, repository.cleaned, reviewer.calls, len(api.notes), len(api.discussions))
	}
	if strings.Contains(api.discussions[0], "@all") || !strings.Contains(api.discussions[0], "&#64;all") {
		t.Fatalf("inline review comment did not neutralize mentions: %s", api.discussions[0])
	}
	if len(api.positions) != 1 || api.positions[0] != (gitlab.DiscussionPosition{
		BaseSHA: baseSHA, StartSHA: strings.Repeat("c", 40), HeadSHA: headSHA,
		OldPath: "main.go", NewPath: "main.go", NewLine: 2,
	}) {
		t.Fatalf("discussion position = %#v", api.positions)
	}
	if !strings.Contains(api.notes[0], "1 finding(s) were posted as inline discussions") ||
		strings.Contains(api.notes[0], "can panic") {
		t.Fatalf("summary note should describe inline findings without duplicating them: %s", api.notes[0])
	}
	job, err := store.GetJob(context.Background(), jobID)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != jobs.StatusCompleted || job.AttemptCount != 1 {
		t.Fatalf("unexpected completed job: %#v", job)
	}
}

func TestWorkerProcessesExplainAtPinnedHead(t *testing.T) {
	headSHA := strings.Repeat("b", 40)
	baseSHA := strings.Repeat("a", 40)
	store, jobID := queuedExplainJob(t, headSHA, "internal/server.go")
	defer store.Close()
	api := &fakeGitLab{
		mergeRequest: gitlab.MergeRequest{
			IID: 8, State: "opened", Title: "Feature",
			DiffRefs: mrRefs(baseSHA, strings.Repeat("c", 40), headSHA),
		},
		project: gitlab.Project{ID: 10, HTTPURLToRepo: "https://gitlab.example.test/p.git"},
	}
	repository := &fakeRepository{fileContent: []byte("package app\nfunc Serve() {}")}
	reviewer := &fakeReviewer{explanation: review.Explanation{
		Text: "This file handles HTTP requests.", Model: "explain-model",
		Usage: agent.ModelUsage{TotalTokens: 10},
	}}
	worker := newTestWorker(t, store, api, repository, reviewer)

	worked, err := worker.processNext(context.Background())
	if err != nil {
		t.Fatalf("processNext() error = %v", err)
	}
	if !worked || !repository.prepared || !repository.cleaned || repository.readPath != "internal/server.go" ||
		repository.diffCalls != 0 || reviewer.explainCalls != 1 || len(api.notes) != 1 {
		t.Fatalf("explanation did not complete as expected: worked=%t prepared=%t cleaned=%t path=%q diffs=%d calls=%d notes=%d",
			worked, repository.prepared, repository.cleaned, repository.readPath,
			repository.diffCalls, reviewer.explainCalls, len(api.notes))
	}
	if !strings.Contains(api.notes[0], "internal/server.go") ||
		!strings.Contains(api.notes[0], "This file handles HTTP requests.") {
		t.Fatalf("unexpected explanation note: %s", api.notes[0])
	}
	job, err := store.GetJob(context.Background(), jobID)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != jobs.StatusCompleted || job.Type != jobs.TypeExplain {
		t.Fatalf("unexpected explain task: %#v", job)
	}
}

func TestWorkerFallsBackToSummaryWhenInlinePositionCannotBePublished(t *testing.T) {
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
			}{BaseSHA: baseSHA, StartSHA: strings.Repeat("c", 40), HeadSHA: headSHA},
		},
		project:       gitlab.Project{ID: 10, HTTPURLToRepo: "https://gitlab.example.test/p.git"},
		discussionErr: errors.New("position no longer exists"),
	}
	repository := &fakeRepository{}
	reviewer := &fakeReviewer{outcome: review.Outcome{Result: review.Result{
		Summary: "Concrete bug found.",
		Findings: []review.Finding{{
			Severity: "high", Title: "Nil access", FilePath: "main.go", Line: 2,
			Evidence: "if value == nil", Explanation: "This value is unsafe here.",
		}},
	}}}
	worker := newTestWorker(t, store, api, repository, reviewer)

	worked, err := worker.processNext(context.Background())
	if err != nil {
		t.Fatalf("processNext() error = %v", err)
	}
	if !worked || len(api.discussions) != 1 || len(api.notes) != 1 {
		t.Fatalf("review fallback did not complete: worked=%t discussions=%d notes=%d",
			worked, len(api.discussions), len(api.notes))
	}
	for _, expected := range []string{"Nil access", "main.go:2", "if value == nil", "position no longer exists"} {
		if !strings.Contains(api.notes[0], expected) {
			t.Errorf("fallback summary does not contain %q: %s", expected, api.notes[0])
		}
	}
	job, err := store.GetJob(context.Background(), jobID)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != jobs.StatusCompleted {
		t.Fatalf("job status = %s, want completed", job.Status)
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

func TestWorkerAppliesAndPublishesFixProposalWithoutPushing(t *testing.T) {
	headSHA := strings.Repeat("b", 40)
	baseSHA := strings.Repeat("a", 40)
	store, jobID := queuedFixJob(t, headSHA, "fix null handling")
	defer store.Close()
	api := &fakeGitLab{
		mergeRequest: gitlab.MergeRequest{
			IID: 8, State: "opened", Title: "Feature",
			DiffRefs: struct {
				BaseSHA  string `json:"base_sha"`
				StartSHA string `json:"start_sha"`
				HeadSHA  string `json:"head_sha"`
			}{BaseSHA: baseSHA, StartSHA: strings.Repeat("c", 40), HeadSHA: headSHA},
		},
		project: gitlab.Project{ID: 10, HTTPURLToRepo: "https://gitlab.example.test/p.git"},
	}
	repository := &fakeRepository{}
	reviewer := &fakeReviewer{}
	patch := "diff --git a/main.go b/main.go\n--- a/main.go\n+++ b/main.go\n@@ -1 +1 @@\n-old\n+new\n"
	fixer := &fakeFixer{outcome: fix.Outcome{Summary: "Handle the nil value.", Patch: patch}}
	worker := newFixTestWorker(t, store, api, repository, reviewer, fixer)

	worked, err := worker.processNext(context.Background())
	if err != nil {
		t.Fatalf("processNext() error = %v", err)
	}
	if !worked || !repository.cleaned || !repository.patchApplied || fixer.calls != 1 ||
		len(api.notes) != 1 || reviewer.calls != 0 {
		t.Fatalf("fix task did not complete as a proposal: worked=%t cleaned=%t applied=%t fixer=%d notes=%d reviews=%d",
			worked, repository.cleaned, repository.patchApplied, fixer.calls, len(api.notes), reviewer.calls)
	}
	for _, expected := range []string{"Handle the nil value.", "git apply --check", "not committed or pushed", patch} {
		if !strings.Contains(api.notes[0], expected) {
			t.Errorf("fix proposal note does not contain %q: %s", expected, api.notes[0])
		}
	}
	if fixer.request != "fix null handling" || repository.allowedPaths != "main.go" {
		t.Fatalf("fix request/path restrictions were lost: request=%q paths=%q",
			fixer.request, repository.allowedPaths)
	}
	job, err := store.GetJob(context.Background(), jobID)
	if err != nil {
		t.Fatal(err)
	}
	if job.Type != jobs.TypeFix || job.Status != jobs.StatusCompleted {
		t.Fatalf("unexpected completed fix job: %#v", job)
	}
}

func TestWorkerDoesNotPublishFixWhenMRChangesDuringProposal(t *testing.T) {
	headSHA := strings.Repeat("b", 40)
	baseSHA := strings.Repeat("a", 40)
	store, jobID := queuedFixJob(t, headSHA, "")
	defer store.Close()
	api := &fakeGitLab{
		mergeRequests: []gitlab.MergeRequest{
			{IID: 8, State: "opened", DiffRefs: mrRefs(baseSHA, strings.Repeat("c", 40), headSHA)},
			{IID: 8, State: "opened", DiffRefs: mrRefs(strings.Repeat("d", 40), strings.Repeat("c", 40), headSHA)},
		},
		project: gitlab.Project{ID: 10, HTTPURLToRepo: "https://gitlab.example.test/p.git"},
	}
	repository := &fakeRepository{}
	fixer := &fakeFixer{outcome: fix.Outcome{Summary: "Change suggested.", Patch: "some patch"}}
	worker := newFixTestWorker(t, store, api, repository, &fakeReviewer{}, fixer)

	worked, err := worker.processNext(context.Background())
	if err != nil {
		t.Fatalf("processNext() error = %v", err)
	}
	if !worked || !repository.patchApplied || !repository.cleaned || len(api.notes) != 1 ||
		!strings.Contains(api.notes[0], "changed while the fix proposal was being prepared") ||
		strings.Contains(api.notes[0], "some patch") {
		t.Fatalf("stale fix proposal was published: worked=%t applied=%t cleaned=%t notes=%v",
			worked, repository.patchApplied, repository.cleaned, api.notes)
	}
	job, err := store.GetJob(context.Background(), jobID)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != jobs.StatusStale {
		t.Fatalf("job status = %s, want stale", job.Status)
	}
}

func TestWorkerFailsAndCleansWorkspaceWhenPatchValidationFails(t *testing.T) {
	headSHA := strings.Repeat("b", 40)
	baseSHA := strings.Repeat("a", 40)
	store, jobID := queuedFixJob(t, headSHA, "")
	defer store.Close()
	api := &fakeGitLab{
		mergeRequest: gitlab.MergeRequest{
			IID: 8, State: "opened", DiffRefs: mrRefs(baseSHA, strings.Repeat("c", 40), headSHA),
		},
		project: gitlab.Project{ID: 10, HTTPURLToRepo: "https://gitlab.example.test/p.git"},
	}
	repository := &fakeRepository{patchErr: errors.New("patch targets an unsupported path")}
	fixer := &fakeFixer{outcome: fix.Outcome{Summary: "Possible fix.", Patch: "invalid patch"}}
	worker := newFixTestWorker(t, store, api, repository, &fakeReviewer{}, fixer)

	worked, err := worker.processNext(context.Background())
	if !worked || err == nil || !repository.cleaned || !repository.patchApplied || len(api.notes) != 0 {
		t.Fatalf("invalid fix patch was not rejected and cleaned: worked=%t err=%v cleaned=%t applied=%t notes=%v",
			worked, err, repository.cleaned, repository.patchApplied, api.notes)
	}
	job, err := store.GetJob(context.Background(), jobID)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != jobs.StatusFailed || job.LastError == "" {
		t.Fatalf("patch validation failure was not stored: %#v", job)
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
				}{BaseSHA: strings.Repeat("d", 40), HeadSHA: headSHA},
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
	}, store, api, repository, reviewer, nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
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
	discussions   []string
	positions     []gitlab.DiscussionPosition
	postErr       error
	discussionErr error
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

func (f *fakeGitLab) PostDiscussion(
	_ context.Context, _, _ int64, body string, position gitlab.DiscussionPosition,
) error {
	f.discussions = append(f.discussions, body)
	f.positions = append(f.positions, position)
	return f.discussionErr
}

type fakeRepository struct {
	headSHA      string
	baseSHA      string
	prepared     bool
	cleaned      bool
	fileContent  []byte
	readPath     string
	diffCalls    int
	patchApplied bool
	allowedPaths string
	patchResult  string
	patchErr     error
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
	f.diffCalls++
	f.baseSHA = baseSHA
	return git.DiffResult{
		BaseSHA: baseSHA, HeadSHA: workspace.HeadSHA,
		Changes: []git.Change{{
			Path: "main.go", Status: "M",
			Patch: "@@ -1,2 +1,3 @@\n package sample\n+if value == nil { return 0 }\n return value\n",
		}},
	}, nil
}

func (f *fakeRepository) ReadFile(_ context.Context, _ git.Workspace, name string, _ int64) ([]byte, error) {
	f.readPath = name
	return f.fileContent, nil
}

func (f *fakeRepository) CleanupWorkspace(context.Context, git.Workspace) error {
	f.cleaned = true
	return nil
}

func (f *fakeRepository) ApplyPatch(
	_ context.Context, _ git.Workspace, patch string, allowed []string, _ int,
) (string, error) {
	f.patchApplied = true
	f.allowedPaths = strings.Join(allowed, ",")
	if f.patchResult != "" {
		return f.patchResult, f.patchErr
	}
	return patch, f.patchErr
}

type fakeReviewer struct {
	outcome      review.Outcome
	explanation  review.Explanation
	calls        int
	explainCalls int
}

func (f *fakeReviewer) Review(context.Context, review.Context, git.DiffResult) (review.Outcome, error) {
	f.calls++
	return f.outcome, nil
}

func (f *fakeReviewer) Explain(context.Context, review.Context, string, []byte) (review.Explanation, error) {
	f.explainCalls++
	return f.explanation, nil
}

type fakeFixer struct {
	outcome fix.Outcome
	request string
	calls   int
}

func (f *fakeFixer) Fix(
	_ context.Context,
	_ review.Context,
	request string,
	_ git.DiffResult,
) (fix.Outcome, error) {
	f.calls++
	f.request = request
	return f.outcome, nil
}

func newFixTestWorker(
	t *testing.T,
	store *jobs.Store,
	api *fakeGitLab,
	repository *fakeRepository,
	reviewer *fakeReviewer,
	fixer *fakeFixer,
) *Worker {
	t.Helper()
	worker, err := NewWorker(config.Config{
		Agent:  config.AgentConfig{Enabled: true},
		Review: config.ReviewConfig{MaxFiles: 50, MaxFindings: 10, MaxContextBytes: 1 << 20},
		Worker: config.WorkerConfig{PollInterval: config.Duration(time.Second), JobTimeout: config.Duration(time.Minute)},
		Fix:    config.FixConfig{Enabled: true, AllowedUserIDs: []int64{99}, MaxPatchBytes: 1024},
	}, store, api, repository, reviewer, fixer, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return worker
}

func queuedFixJob(t *testing.T, headSHA, request string) (*jobs.Store, string) {
	t.Helper()
	store, err := jobs.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	result, err := store.CreateFix(context.Background(), "fix-note-1", "fix-key-1", jobs.Job{
		ProjectID: 10, MRIID: 8, HeadSHA: headSHA, ActorID: 99, Request: request,
	}, true, true)
	if err != nil {
		store.Close()
		t.Fatal(err)
	}
	parts := strings.Split(result.Response, "`")
	if len(parts) < 2 {
		store.Close()
		t.Fatalf("could not parse queued fix ID from %q", result.Response)
	}
	return store, parts[1]
}

func queuedExplainJob(t *testing.T, headSHA, path string) (*jobs.Store, string) {
	t.Helper()
	store, err := jobs.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	result, err := store.CreateExplain(context.Background(), "explain-note-1", "explain-key-1", jobs.Job{
		ProjectID: 10, MRIID: 8, HeadSHA: headSHA, ActorID: 42, Request: path,
	})
	if err != nil {
		store.Close()
		t.Fatal(err)
	}
	parts := strings.Split(result.Response, "`")
	if len(parts) < 2 {
		store.Close()
		t.Fatalf("could not parse queued explain ID from %q", result.Response)
	}
	return store, parts[1]
}

func mrRefs(baseSHA, startSHA, headSHA string) struct {
	BaseSHA  string `json:"base_sha"`
	StartSHA string `json:"start_sha"`
	HeadSHA  string `json:"head_sha"`
} {
	return struct {
		BaseSHA  string `json:"base_sha"`
		StartSHA string `json:"start_sha"`
		HeadSHA  string `json:"head_sha"`
	}{BaseSHA: baseSHA, StartSHA: startSHA, HeadSHA: headSHA}
}
