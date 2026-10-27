package jobs

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

func Open(path string) (*Store, error) {
	if path == "" {
		return nil, errors.New("database path is required")
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open SQLite database: %w", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;`); err != nil {
		db.Close()
		return nil, fmt.Errorf("configure SQLite: %w", err)
	}
	store := &Store{db: db}
	if err := store.migrate(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) migrate(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  mr_iid INTEGER NOT NULL,
  head_sha TEXT NOT NULL DEFAULT '',
  actor_id INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_mr_created_idx
  ON jobs(project_id, mr_iid, created_at DESC);
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS job_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  attempt INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT NOT NULL DEFAULT '',
  UNIQUE(job_id, attempt)
);`
	if _, err := s.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate task store: %w", err)
	}
	for _, column := range []struct {
		name       string
		definition string
	}{
		{name: "attempt_count", definition: "INTEGER NOT NULL DEFAULT 0"},
		{name: "last_error", definition: "TEXT NOT NULL DEFAULT ''"},
	} {
		if err := s.ensureJobColumn(ctx, column.name, column.definition); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) Ping(ctx context.Context) error {
	return s.db.PingContext(ctx)
}

func (s *Store) CreateReview(ctx context.Context, eventID, key string, job Job) (EventResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return EventResult{}, err
	}
	defer tx.Rollback()

	if result, found, err := eventResult(ctx, tx, eventID); err != nil {
		return EventResult{}, err
	} else if found {
		return result, nil
	}

	existing, err := getJobByKey(ctx, tx, key)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return EventResult{}, err
	}
	if err == nil {
		response := fmt.Sprintf("Review task `%s` is already queued for this comment.", existing.ID)
		if err := insertEvent(ctx, tx, eventID, response); err != nil {
			return EventResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return EventResult{}, err
		}
		return EventResult{Response: response}, nil
	}

	job.ID, err = newID()
	if err != nil {
		return EventResult{}, err
	}
	job.Type = TypeReview
	job.Status = StatusQueued
	job.CreatedAt = time.Now().UTC()
	_, err = tx.ExecContext(ctx, `INSERT INTO jobs
		(id, idempotency_key, event_id, type, status, project_id, mr_iid, head_sha, actor_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		job.ID, key, eventID, job.Type, job.Status, job.ProjectID, job.MRIID, job.HeadSHA, job.ActorID,
		job.CreatedAt.Format(time.RFC3339Nano), job.CreatedAt.Format(time.RFC3339Nano))
	if err != nil {
		return EventResult{}, fmt.Errorf("insert review task: %w", err)
	}
	response := fmt.Sprintf("Queued review task `%s` for MR !%d at `%s`.", job.ID, job.MRIID, shortSHA(job.HeadSHA))
	if err := insertEvent(ctx, tx, eventID, response); err != nil {
		return EventResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return EventResult{}, err
	}
	return EventResult{Response: response}, nil
}

func (s *Store) Status(ctx context.Context, eventID string, projectID, mrIID, actorID int64) (EventResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return EventResult{}, err
	}
	defer tx.Rollback()
	if result, found, err := eventResult(ctx, tx, eventID); err != nil {
		return EventResult{}, err
	} else if found {
		return result, nil
	}
	job, err := latestJob(ctx, tx, projectID, mrIID)
	var response string
	if errors.Is(err, sql.ErrNoRows) {
		response = "No Corvex task has been created for this MR."
	} else if err != nil {
		return EventResult{}, err
	} else {
		response = fmt.Sprintf("Latest task `%s`: **%s** (requested by user %d).", job.ID, job.Status, job.ActorID)
	}
	if err := insertEvent(ctx, tx, eventID, response); err != nil {
		return EventResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return EventResult{}, err
	}
	return EventResult{Response: response}, nil
}

func (s *Store) Cancel(ctx context.Context, eventID string, projectID, mrIID, actorID int64) (EventResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return EventResult{}, err
	}
	defer tx.Rollback()
	if result, found, err := eventResult(ctx, tx, eventID); err != nil {
		return EventResult{}, err
	} else if found {
		return result, nil
	}

	job, err := latestJob(ctx, tx, projectID, mrIID)
	var response string
	if errors.Is(err, sql.ErrNoRows) {
		response = "There is no task to cancel for this MR."
	} else if err != nil {
		return EventResult{}, err
	} else if job.ActorID != actorID {
		response = "You can only cancel a task that you started."
		_, err = tx.ExecContext(ctx,
			`INSERT INTO audit_events(actor_id, action, resource, result, created_at) VALUES (?, ?, ?, ?, ?)`,
			actorID, "cancel_job", job.ID, "denied_not_owner", time.Now().UTC().Format(time.RFC3339Nano))
		if err != nil {
			return EventResult{}, err
		}
	} else if job.Status != StatusQueued {
		response = fmt.Sprintf("Task `%s` is %s and can no longer be cancelled.", job.ID, job.Status)
	} else {
		now := time.Now().UTC().Format(time.RFC3339Nano)
		if _, err := tx.ExecContext(ctx, `UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND status = ?`,
			StatusCancelled, now, job.ID, StatusQueued); err != nil {
			return EventResult{}, err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO audit_events(actor_id, action, resource, result, created_at) VALUES (?, ?, ?, ?, ?)`,
			actorID, "cancel_job", job.ID, "cancelled", now); err != nil {
			return EventResult{}, err
		}
		response = fmt.Sprintf("Cancelled task `%s`.", job.ID)
	}
	if err := insertEvent(ctx, tx, eventID, response); err != nil {
		return EventResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return EventResult{}, err
	}
	return EventResult{Response: response}, nil
}

func (s *Store) MarkDelivered(ctx context.Context, eventID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE webhook_events SET delivered = 1 WHERE event_id = ?`, eventID)
	return err
}

func (s *Store) RecordResponse(ctx context.Context, eventID, response string) (EventResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return EventResult{}, err
	}
	defer tx.Rollback()
	if result, found, err := eventResult(ctx, tx, eventID); err != nil {
		return EventResult{}, err
	} else if found {
		return result, nil
	}
	if err := insertEvent(ctx, tx, eventID, response); err != nil {
		return EventResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return EventResult{}, err
	}
	return EventResult{Response: response}, nil
}

func (s *Store) RecordFixAuthorization(
	ctx context.Context,
	eventID string,
	projectID, mrIID, actorID int64,
	enabled, authorized bool,
) (EventResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return EventResult{}, err
	}
	defer tx.Rollback()
	if result, found, err := eventResult(ctx, tx, eventID); err != nil {
		return EventResult{}, err
	} else if found {
		return result, nil
	}

	result := "authorized_executor_unavailable"
	response := "You are authorized to request fixes, but patch generation is not available yet. No task was queued and no code was changed."
	if !enabled {
		result = "denied_disabled"
		response = "The `fix` command is disabled by configuration."
	} else if !authorized {
		result = "denied_not_allowlisted"
		response = "You are not authorized to request code fixes."
	}
	if err := insertEvent(ctx, tx, eventID, response); err != nil {
		return EventResult{}, err
	}
	resource := fmt.Sprintf("%d:%d", projectID, mrIID)
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO audit_events(actor_id, action, resource, result, created_at) VALUES (?, ?, ?, ?, ?)`,
		actorID, "request_fix", resource, result, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return EventResult{}, fmt.Errorf("record fix authorization audit: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return EventResult{}, err
	}
	return EventResult{Response: response}, nil
}

func (s *Store) ClaimNext(ctx context.Context) (Job, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Job{}, false, err
	}
	defer tx.Rollback()

	now := time.Now().UTC().Format(time.RFC3339Nano)
	var job Job
	var created string
	err = tx.QueryRowContext(ctx, `UPDATE jobs
		SET status = ?, attempt_count = attempt_count + 1, updated_at = ?
		WHERE id = (SELECT id FROM jobs WHERE status = ? AND type = ? ORDER BY created_at LIMIT 1)
		  AND status = ?
		RETURNING id, type, status, project_id, mr_iid, head_sha, actor_id, created_at, attempt_count, last_error`,
		StatusPreparing, now, StatusQueued, TypeReview, StatusQueued).Scan(
		&job.ID, &job.Type, &job.Status, &job.ProjectID, &job.MRIID, &job.HeadSHA, &job.ActorID,
		&created, &job.AttemptCount, &job.LastError)
	if errors.Is(err, sql.ErrNoRows) {
		return Job{}, false, nil
	}
	if err != nil {
		return Job{}, false, fmt.Errorf("claim queued review task: %w", err)
	}
	job.CreatedAt, err = time.Parse(time.RFC3339Nano, created)
	if err != nil {
		return Job{}, false, fmt.Errorf("parse job creation time: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO job_attempts(job_id, attempt, started_at) VALUES (?, ?, ?)`,
		job.ID, job.AttemptCount, now); err != nil {
		return Job{}, false, fmt.Errorf("record job attempt: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Job{}, false, err
	}
	return job, true, nil
}

func (s *Store) UpdateStatus(ctx context.Context, jobID, from, to, failure string) error {
	if !validTransition(from, to) {
		return fmt.Errorf("invalid job transition %q -> %q", from, to)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := tx.ExecContext(ctx, `UPDATE jobs SET status = ?, last_error = ?, updated_at = ?
		WHERE id = ? AND status = ?`, to, failure, now, jobID, from)
	if err != nil {
		return fmt.Errorf("update job status: %w", err)
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if updated != 1 {
		return fmt.Errorf("job %q is no longer in status %q", jobID, from)
	}
	if isTerminal(to) {
		if _, err := tx.ExecContext(ctx, `UPDATE job_attempts SET finished_at = ?, error = ?
			WHERE job_id = ? AND finished_at IS NULL`, now, failure, jobID); err != nil {
			return fmt.Errorf("finish job attempt: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return nil
}

func (s *Store) GetJob(ctx context.Context, jobID string) (Job, error) {
	var job Job
	var created string
	err := s.db.QueryRowContext(ctx, `SELECT id, type, status, project_id, mr_iid, head_sha, actor_id,
		created_at, attempt_count, last_error FROM jobs WHERE id = ?`, jobID).Scan(
		&job.ID, &job.Type, &job.Status, &job.ProjectID, &job.MRIID, &job.HeadSHA, &job.ActorID,
		&created, &job.AttemptCount, &job.LastError)
	if err != nil {
		return Job{}, err
	}
	job.CreatedAt, err = time.Parse(time.RFC3339Nano, created)
	return job, err
}

func (s *Store) ensureJobColumn(ctx context.Context, column, definition string) error {
	rows, err := s.db.QueryContext(ctx, `PRAGMA table_info(jobs)`)
	if err != nil {
		return fmt.Errorf("inspect jobs schema: %w", err)
	}
	found := false
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			rows.Close()
			return fmt.Errorf("read jobs schema: %w", err)
		}
		if name == column {
			found = true
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("iterate jobs schema: %w", err)
	}
	rows.Close()
	if found {
		return nil
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE jobs ADD COLUMN `+column+` `+definition); err != nil {
		return fmt.Errorf("add jobs.%s column: %w", column, err)
	}
	return nil
}

func validTransition(from, to string) bool {
	switch from {
	case StatusQueued:
		return to == StatusPreparing || to == StatusCancelled
	case StatusPreparing:
		return to == StatusAnalyzing || to == StatusStale || to == StatusFailed
	case StatusAnalyzing:
		return to == StatusFixing || to == StatusPublishing || to == StatusStale || to == StatusFailed
	case StatusFixing:
		return to == StatusVerifying || to == StatusStale || to == StatusFailed
	case StatusVerifying:
		return to == StatusPublishing || to == StatusStale || to == StatusFailed
	case StatusPublishing:
		return to == StatusCompleted || to == StatusStale || to == StatusFailed
	default:
		return false
	}
}

func isTerminal(status string) bool {
	switch status {
	case StatusCompleted, StatusFailed, StatusStale, StatusCancelled:
		return true
	default:
		return false
	}
}

func eventResult(ctx context.Context, tx *sql.Tx, id string) (EventResult, bool, error) {
	var result EventResult
	var delivered int
	err := tx.QueryRowContext(ctx, `SELECT response, delivered FROM webhook_events WHERE event_id = ?`, id).
		Scan(&result.Response, &delivered)
	if errors.Is(err, sql.ErrNoRows) {
		return EventResult{}, false, nil
	}
	result.Delivered = delivered != 0
	return result, err == nil, err
}

func insertEvent(ctx context.Context, tx *sql.Tx, eventID, response string) error {
	_, err := tx.ExecContext(ctx,
		`INSERT INTO webhook_events(event_id, response, received_at) VALUES (?, ?, ?)`,
		eventID, response, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("record webhook event: %w", err)
	}
	return nil
}

type querier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func getJobByKey(ctx context.Context, q querier, key string) (Job, error) {
	var job Job
	var created string
	err := q.QueryRowContext(ctx, `SELECT id, type, status, project_id, mr_iid, head_sha, actor_id, created_at
		FROM jobs WHERE idempotency_key = ?`, key).Scan(
		&job.ID, &job.Type, &job.Status, &job.ProjectID, &job.MRIID, &job.HeadSHA, &job.ActorID, &created)
	if err != nil {
		return Job{}, err
	}
	job.CreatedAt, err = time.Parse(time.RFC3339Nano, created)
	return job, err
}

func latestJob(ctx context.Context, q querier, projectID, mrIID int64) (Job, error) {
	var job Job
	var created string
	err := q.QueryRowContext(ctx, `SELECT id, type, status, project_id, mr_iid, head_sha, actor_id, created_at
		FROM jobs WHERE project_id = ? AND mr_iid = ? ORDER BY created_at DESC LIMIT 1`, projectID, mrIID).
		Scan(&job.ID, &job.Type, &job.Status, &job.ProjectID, &job.MRIID, &job.HeadSHA, &job.ActorID, &created)
	if err != nil {
		return Job{}, err
	}
	job.CreatedAt, err = time.Parse(time.RFC3339Nano, created)
	return job, err
}

func newID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(b)
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:], nil
}

func shortSHA(sha string) string {
	if sha == "" {
		return "unknown SHA"
	}
	if len(sha) > 12 {
		return sha[:12]
	}
	return sha
}
