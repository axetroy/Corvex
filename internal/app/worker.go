package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/axetroy/corvex/internal/config"
	"github.com/axetroy/corvex/internal/git"
	"github.com/axetroy/corvex/internal/gitlab"
	"github.com/axetroy/corvex/internal/jobs"
	"github.com/axetroy/corvex/internal/review"
)

type gitLabReviewClient interface {
	GetProject(context.Context, int64) (gitlab.Project, error)
	GetMergeRequest(context.Context, int64, int64) (gitlab.MergeRequest, error)
	PostNote(context.Context, int64, int64, string) error
}

type repositoryManager interface {
	PrepareWorkspace(context.Context, int64, string, string, string) (git.Workspace, error)
	Diff(context.Context, git.Workspace, string, int, int) (git.DiffResult, error)
	CleanupWorkspace(context.Context, git.Workspace) error
}

type reviewWorkflow interface {
	Review(context.Context, review.Context, git.DiffResult) (review.Outcome, error)
}

type Worker struct {
	cfg      config.Config
	store    *jobs.Store
	gitlab   gitLabReviewClient
	repo     repositoryManager
	reviewer reviewWorkflow
	logger   *slog.Logger
}

func NewWorker(
	cfg config.Config,
	store *jobs.Store,
	gitlabClient gitLabReviewClient,
	repo repositoryManager,
	reviewer reviewWorkflow,
	logger *slog.Logger,
) (*Worker, error) {
	if !cfg.Agent.Enabled {
		return nil, errors.New("worker requires agent.enabled=true")
	}
	if store == nil || gitlabClient == nil || repo == nil || reviewer == nil || logger == nil {
		return nil, errors.New("worker dependencies must be provided")
	}
	if cfg.Worker.PollInterval <= 0 || cfg.Worker.JobTimeout <= 0 {
		return nil, errors.New("worker intervals and timeouts must be positive")
	}
	return &Worker{
		cfg: cfg, store: store, gitlab: gitlabClient, repo: repo, reviewer: reviewer, logger: logger,
	}, nil
}

func (w *Worker) Run(ctx context.Context) error {
	pollInterval := time.Duration(w.cfg.Worker.PollInterval)
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	w.logger.Info("Corvex worker started", "poll_interval", pollInterval)
	for {
		worked, err := w.processNext(ctx)
		if err != nil {
			w.logger.Error("process review task", "error", err)
		}
		if worked {
			continue
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func (w *Worker) processNext(ctx context.Context) (bool, error) {
	job, found, err := w.store.ClaimNext(ctx)
	if err != nil || !found {
		return false, err
	}
	stage := job.Status
	jobCtx, cancel := context.WithTimeout(ctx, time.Duration(w.cfg.Worker.JobTimeout))
	defer cancel()
	err = w.execute(jobCtx, job, &stage)
	if err == nil {
		return true, nil
	}
	if !terminalStatus(stage) {
		failureCtx, failureCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer failureCancel()
		if updateErr := w.store.UpdateStatus(failureCtx, job.ID, stage, jobs.StatusFailed, err.Error()); updateErr != nil {
			return true, errors.Join(err, fmt.Errorf("mark task failed: %w", updateErr))
		}
	}
	return true, err
}

func (w *Worker) execute(ctx context.Context, job jobs.Job, stage *string) (resultErr error) {
	if len(job.HeadSHA) != 40 && len(job.HeadSHA) != 64 {
		return w.markStale(ctx, job, stage, "The review task did not include a full MR Head SHA.")
	}
	mergeRequest, err := w.gitlab.GetMergeRequest(ctx, job.ProjectID, job.MRIID)
	if err != nil {
		return fmt.Errorf("fetch MR snapshot: %w", err)
	}
	if mergeRequest.State != "opened" {
		return w.markStale(ctx, job, stage, "The merge request is no longer open; the review was skipped.")
	}
	if !strings.EqualFold(mergeRequest.HeadSHA(), job.HeadSHA) {
		return w.markStale(ctx, job, stage, "The MR Head changed after this review was queued; the task was marked stale.")
	}
	if mergeRequest.DiffRefs.BaseSHA == "" {
		return errors.New("GitLab did not provide the MR base SHA")
	}
	project, err := w.gitlab.GetProject(ctx, job.ProjectID)
	if err != nil {
		return fmt.Errorf("fetch GitLab project: %w", err)
	}
	workspace, err := w.repo.PrepareWorkspace(ctx, job.ProjectID, job.ID, project.HTTPURLToRepo, job.HeadSHA)
	if err != nil {
		return fmt.Errorf("prepare exact-SHA workspace: %w", err)
	}
	cleaned := false
	defer func() {
		if cleaned {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := w.repo.CleanupWorkspace(cleanupCtx, workspace); err != nil {
			resultErr = errors.Join(resultErr, fmt.Errorf("clean review workspace: %w", err))
		}
	}()

	diff, err := w.repo.Diff(ctx, workspace, mergeRequest.DiffRefs.BaseSHA,
		w.cfg.Review.MaxFiles, w.cfg.Review.MaxContextBytes)
	if err != nil {
		return fmt.Errorf("build MR diff: %w", err)
	}
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
	cleanupErr := w.repo.CleanupWorkspace(cleanupCtx, workspace)
	cleanupCancel()
	cleaned = cleanupErr == nil
	if cleanupErr != nil {
		return fmt.Errorf("clean review workspace before model call: %w", cleanupErr)
	}
	if err := w.transition(ctx, job.ID, stage, jobs.StatusAnalyzing); err != nil {
		return err
	}
	outcome, err := w.reviewer.Review(ctx, review.Context{
		ProjectID: job.ProjectID, MRIID: job.MRIID, Title: mergeRequest.Title,
		Description: mergeRequest.Description, SourceBranch: mergeRequest.SourceBranch,
		TargetBranch: mergeRequest.TargetBranch, BaseSHA: mergeRequest.DiffRefs.BaseSHA,
		HeadSHA: job.HeadSHA,
	}, diff)
	if err != nil {
		return err
	}

	latest, err := w.gitlab.GetMergeRequest(ctx, job.ProjectID, job.MRIID)
	if err != nil {
		return fmt.Errorf("recheck MR Head before publishing: %w", err)
	}
	if latest.State != "opened" || !strings.EqualFold(latest.HeadSHA(), job.HeadSHA) {
		return w.markStale(ctx, job, stage, "The MR changed while the review was running; no result was published.")
	}
	if err := w.transition(ctx, job.ID, stage, jobs.StatusPublishing); err != nil {
		return err
	}
	if err := w.gitlab.PostNote(ctx, job.ProjectID, job.MRIID, formatReview(job, outcome)); err != nil {
		return fmt.Errorf("publish review summary: %w", err)
	}
	return w.transition(ctx, job.ID, stage, jobs.StatusCompleted)
}

func (w *Worker) transition(ctx context.Context, jobID string, stage *string, next string) error {
	if err := w.store.UpdateStatus(ctx, jobID, *stage, next, ""); err != nil {
		return err
	}
	*stage = next
	return nil
}

func (w *Worker) markStale(ctx context.Context, job jobs.Job, stage *string, message string) error {
	if err := w.transition(ctx, job.ID, stage, jobs.StatusStale); err != nil {
		return err
	}
	if err := w.gitlab.PostNote(ctx, job.ProjectID, job.MRIID,
		fmt.Sprintf("Review task `%s` was skipped: %s", job.ID, message)); err != nil {
		return fmt.Errorf("publish stale-task notice: %w", err)
	}
	return nil
}

func formatReview(job jobs.Job, outcome review.Outcome) string {
	var report strings.Builder
	fmt.Fprintf(&report, "## Corvex review for `%s`\n\n", job.HeadSHA[:min(12, len(job.HeadSHA))])
	report.WriteString(escapeReviewText(outcome.Result.Summary))
	if len(outcome.Result.Findings) == 0 {
		report.WriteString("\n\nNo validated findings.")
	}
	for _, finding := range outcome.Result.Findings {
		fmt.Fprintf(&report, "\n\n- **%s** — `%s:%d`: %s",
			strings.ToUpper(finding.Severity), escapeReviewText(finding.FilePath), finding.Line,
			escapeReviewText(finding.Title))
		fmt.Fprintf(&report, "\n  %s", escapeReviewText(finding.Explanation))
		fmt.Fprintf(&report, "\n  Evidence: `%s`", escapeReviewText(finding.Evidence))
		if finding.Suggestion != "" {
			fmt.Fprintf(&report, "\n  Suggestion: %s", escapeReviewText(finding.Suggestion))
		}
	}
	if outcome.OmittedFiles > 0 {
		fmt.Fprintf(&report, "\n\n%d changed file(s) were omitted by the review limits.", outcome.OmittedFiles)
	}
	if outcome.Rejected > 0 {
		fmt.Fprintf(&report, "\n%d unsupported finding(s) were discarded.", outcome.Rejected)
	}
	return report.String()
}

func escapeReviewText(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	value = strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		"@", "&#64;",
		"\\", "\\\\",
		"`", "\\`",
		"*", "\\*",
		"_", "\\_",
		"[", "\\[",
		"]", "\\]",
		"(", "\\(",
		")", "\\)",
		"#", "\\#",
	).Replace(value)
	return value
}

func terminalStatus(status string) bool {
	switch status {
	case jobs.StatusCompleted, jobs.StatusFailed, jobs.StatusStale, jobs.StatusCancelled:
		return true
	default:
		return false
	}
}
