package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/axetroy/corvex/internal/config"
	"github.com/axetroy/corvex/internal/gitlab"
	"github.com/axetroy/corvex/internal/jobs"
)

type Server struct {
	cfg    config.Config
	store  *jobs.Store
	gitlab *gitlab.Client
	logger *slog.Logger
}

func NewServer(cfg config.Config, store *jobs.Store, client *gitlab.Client, logger *slog.Logger) *Server {
	return &Server{cfg: cfg, store: store, gitlab: client, logger: logger}
}

func (s *Server) Run(ctx context.Context) error {
	httpServer := &http.Server{
		Addr:              s.cfg.Server.Listen,
		Handler:           s.Handler(),
		ReadHeaderTimeout: time.Duration(s.cfg.Server.ReadTimeout),
	}
	listener, err := net.Listen("tcp", httpServer.Addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", httpServer.Addr, err)
	}
	retentionCtx, stopRetention := context.WithCancel(ctx)
	retentionDone := make(chan struct{})
	go func() {
		defer close(retentionDone)
		s.runRetention(retentionCtx)
	}()
	defer func() {
		stopRetention()
		<-retentionDone
	}()
	s.logger.Info("Corvex server listening", "address", httpServer.Addr)
	errCh := make(chan error, 1)
	go func() { errCh <- httpServer.Serve(listener) }()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), time.Duration(s.cfg.Server.ShutdownTimeout))
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shut down HTTP server: %w", err)
		}
		return nil
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve HTTP: %w", err)
	}
}

func (s *Server) runRetention(ctx context.Context) {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		now := time.Now().UTC()
		historyBefore := now.AddDate(0, 0, -s.cfg.Storage.RetentionDays)
		auditBefore := now.AddDate(0, 0, -s.cfg.Storage.AuditRetentionDays)
		cleanupCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		if err := s.store.PruneHistory(cleanupCtx, historyBefore, auditBefore); err != nil {
			s.logger.Error("prune persisted history", "error", err)
		}
		cancel()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /readyz", s.ready)
	mux.HandleFunc("GET /metrics", s.metrics)
	mux.HandleFunc("POST /webhooks/gitlab", s.webhook)
	return mux
}

func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	if err := s.store.Ping(r.Context()); err != nil {
		http.Error(w, "not ready", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ready\n"))
}

func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	counts, err := s.store.JobCounts(r.Context())
	if err != nil {
		s.logger.Error("collect job metrics", "error", err)
		http.Error(w, "metrics unavailable", http.StatusServiceUnavailable)
		return
	}
	modelCalls, err := s.store.ModelCallMetrics(r.Context())
	if err != nil {
		s.logger.Error("collect model call metrics", "error", err)
		http.Error(w, "metrics unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = fmt.Fprintln(w, "# HELP corvex_jobs Number of persisted tasks by lifecycle status.")
	_, _ = fmt.Fprintln(w, "# TYPE corvex_jobs gauge")
	for _, status := range []string{
		jobs.StatusQueued, jobs.StatusPreparing, jobs.StatusAnalyzing, jobs.StatusFixing,
		jobs.StatusVerifying, jobs.StatusPublishing, jobs.StatusCompleted, jobs.StatusFailed,
		jobs.StatusStale, jobs.StatusCancelled,
	} {
		_, _ = fmt.Fprintf(w, "corvex_jobs{status=%q} %d\n", status, counts[status])
	}
	_, _ = fmt.Fprintln(w, "# HELP corvex_model_calls_total Model API calls by task type and outcome.")
	_, _ = fmt.Fprintln(w, "# TYPE corvex_model_calls_total counter")
	_, _ = fmt.Fprintln(w, "# HELP corvex_model_call_duration_seconds_sum Total duration of model API calls.")
	_, _ = fmt.Fprintln(w, "# TYPE corvex_model_call_duration_seconds_sum counter")
	_, _ = fmt.Fprintln(w, "# HELP corvex_model_input_tokens_total Input tokens reported for model API calls.")
	_, _ = fmt.Fprintln(w, "# TYPE corvex_model_input_tokens_total counter")
	_, _ = fmt.Fprintln(w, "# HELP corvex_model_output_tokens_total Output tokens reported for model API calls.")
	_, _ = fmt.Fprintln(w, "# TYPE corvex_model_output_tokens_total counter")
	for _, metric := range modelCalls {
		labels := fmt.Sprintf(`task_type=%q,outcome=%q`, metric.TaskType, metric.Outcome)
		_, _ = fmt.Fprintf(w, "corvex_model_calls_total{%s} %d\n", labels, metric.Calls)
		_, _ = fmt.Fprintf(w, "corvex_model_call_duration_seconds_sum{%s} %.3f\n",
			labels, float64(metric.DurationMS)/1000)
		_, _ = fmt.Fprintf(w, "corvex_model_input_tokens_total{%s} %d\n", labels, metric.InputTokens)
		_, _ = fmt.Fprintf(w, "corvex_model_output_tokens_total{%s} %d\n", labels, metric.OutputTokens)
	}
}

func (s *Server) webhook(w http.ResponseWriter, r *http.Request) {
	if !gitlab.ValidateWebhookToken(s.cfg.GitLab.WebhookSecret, r.Header.Get("X-Gitlab-Token")) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if r.Header.Get("X-Gitlab-Event") != "Note Hook" {
		http.Error(w, "unsupported event", http.StatusBadRequest)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	event, err := gitlab.DecodeNoteEvent(r.Body)
	if err != nil {
		http.Error(w, "invalid webhook payload", http.StatusBadRequest)
		return
	}
	if event.ObjectAttributes.System || (s.cfg.GitLab.BotUsername != "" &&
		strings.EqualFold(event.User.Username, s.cfg.GitLab.BotUsername)) {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	if !contains(s.cfg.GitLab.AllowedProjectIDs, event.Project.ID) {
		http.Error(w, "project is not allowed", http.StatusForbidden)
		return
	}
	if !contains(s.cfg.GitLab.AllowedUserIDs, event.User.ID) {
		http.Error(w, "user is not allowed", http.StatusForbidden)
		return
	}
	command, err := gitlab.ParseCommand(event.ObjectAttributes.Note)
	if errors.Is(err, gitlab.ErrNotCommand) {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	if err != nil {
		s.reply(w, r, event, err.Error())
		return
	}
	if command.Name == "explain" && len(command.Args) == 0 {
		s.reply(w, r, event, "Usage: `@corvex explain <path>`.")
		return
	}
	if len(command.Args) > 1 || (len(command.Args) == 1 && command.Name != "fix" && command.Name != "explain") {
		s.reply(w, r, event, "This command does not accept arguments.")
		return
	}

	eventID := noteEventID(event)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	var result jobs.EventResult
	switch command.Name {
	case "review":
		key := fmt.Sprintf("%d:%d:%s", event.Project.ID, event.MergeRequest.IID, eventID)
		result, err = s.store.CreateReview(ctx, eventID, key, jobs.Job{
			ProjectID: event.Project.ID, MRIID: event.MergeRequest.IID, HeadSHA: event.MergeRequest.LastCommit.ID,
			ActorID: event.User.ID,
		})
	case "status":
		result, err = s.store.Status(ctx, eventID, event.Project.ID, event.MergeRequest.IID, event.User.ID)
	case "cancel":
		result, err = s.store.Cancel(ctx, eventID, event.Project.ID, event.MergeRequest.IID, event.User.ID)
	case "fix":
		key := fmt.Sprintf("%d:%d:fix:%s", event.Project.ID, event.MergeRequest.IID, eventID)
		result, err = s.store.CreateFix(ctx, eventID, key, jobs.Job{
			ProjectID: event.Project.ID, MRIID: event.MergeRequest.IID,
			HeadSHA: event.MergeRequest.LastCommit.ID, ActorID: event.User.ID,
			Request: strings.Join(command.Args, " "),
		}, s.cfg.Fix.Enabled, contains(s.cfg.Fix.AllowedUserIDs, event.User.ID))
	case "explain":
		key := fmt.Sprintf("%d:%d:explain:%s", event.Project.ID, event.MergeRequest.IID, eventID)
		result, err = s.store.CreateExplain(ctx, eventID, key, jobs.Job{
			ProjectID: event.Project.ID, MRIID: event.MergeRequest.IID,
			HeadSHA: event.MergeRequest.LastCommit.ID, ActorID: event.User.ID,
			Request: command.Args[0],
		})
	default:
		result, err = s.recordResponse(ctx, eventID, fmt.Sprintf("The `%s` command is not implemented yet.", command.Name))
	}
	if err != nil {
		s.logger.Error("process GitLab command", "event_id", eventID, "error", err)
		http.Error(w, "failed to process command", http.StatusInternalServerError)
		return
	}
	if !result.Delivered {
		if err := s.gitlab.PostNote(ctx, event.Project.ID, event.MergeRequest.IID, result.Response); err != nil {
			s.logger.Error("publish GitLab response", "event_id", eventID, "project_id", event.Project.ID, "error", err)
			http.Error(w, "failed to publish command response", http.StatusBadGateway)
			return
		}
		if err := s.store.MarkDelivered(ctx, eventID); err != nil {
			s.logger.Error("mark webhook response delivered", "event_id", eventID, "error", err)
			http.Error(w, "failed to persist response delivery", http.StatusInternalServerError)
			return
		}
	}
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) recordResponse(ctx context.Context, eventID, response string) (jobs.EventResult, error) {
	return s.store.RecordResponse(ctx, eventID, response)
}

func (s *Server) reply(w http.ResponseWriter, r *http.Request, event gitlab.NoteEvent, message string) {
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	id := noteEventID(event)
	result, err := s.store.RecordResponse(ctx, id, message)
	if err != nil {
		http.Error(w, "failed to record command response", http.StatusInternalServerError)
		return
	}
	if !result.Delivered {
		if err := s.gitlab.PostNote(ctx, event.Project.ID, event.MergeRequest.IID, result.Response); err != nil {
			s.logger.Error("publish GitLab command error", "event_id", id, "error", err)
			http.Error(w, "failed to publish command response", http.StatusBadGateway)
			return
		}
		if err := s.store.MarkDelivered(ctx, id); err != nil {
			http.Error(w, "failed to persist response delivery", http.StatusInternalServerError)
			return
		}
	}
	w.WriteHeader(http.StatusAccepted)
}

func noteEventID(event gitlab.NoteEvent) string {
	return fmt.Sprintf("%d:%d", event.Project.ID, event.ObjectAttributes.ID)
}

func contains(values []int64, target int64) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
