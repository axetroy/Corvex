package jobs

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCreateReviewIsIdempotentAndCancelChecksOwner(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()

	first, err := store.CreateReview(ctx, "note-1", "project:mr:note-1", Job{
		ProjectID: 10, MRIID: 5, HeadSHA: "0123456789abcdef", ActorID: 42,
	})
	if err != nil {
		t.Fatal(err)
	}
	if first.Response == "" || first.Delivered {
		t.Fatalf("unexpected first event result: %#v", first)
	}
	duplicate, err := store.CreateReview(ctx, "note-1", "project:mr:note-1", Job{
		ProjectID: 10, MRIID: 5, ActorID: 42,
	})
	if err != nil {
		t.Fatal(err)
	}
	if duplicate.Response != first.Response {
		t.Fatalf("duplicate response %q differs from original %q", duplicate.Response, first.Response)
	}

	denied, err := store.Cancel(ctx, "note-2", 10, 5, 99)
	if err != nil {
		t.Fatal(err)
	}
	if denied.Response != "You can only cancel a task that you started." {
		t.Fatalf("unexpected unauthorized cancellation result %q", denied.Response)
	}
	cancelled, err := store.Cancel(ctx, "note-3", 10, 5, 42)
	if err != nil {
		t.Fatal(err)
	}
	if cancelled.Response == "" || cancelled.Response == denied.Response {
		t.Fatalf("unexpected cancellation result %q", cancelled.Response)
	}

	status, err := store.Status(ctx, "note-4", 10, 5, 42)
	if err != nil {
		t.Fatal(err)
	}
	if status.Response == "" {
		t.Fatal("status response is empty")
	}
}

func TestEventResponseCanBeRetriedUntilDelivered(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()

	first, err := store.RecordResponse(ctx, "note-1", "response")
	if err != nil {
		t.Fatal(err)
	}
	if first.Delivered {
		t.Fatal("new response is already marked delivered")
	}
	retry, err := store.RecordResponse(ctx, "note-1", "different response")
	if err != nil {
		t.Fatal(err)
	}
	if retry.Response != "response" || retry.Delivered {
		t.Fatalf("unexpected retry result: %#v", retry)
	}
	if err := store.MarkDelivered(ctx, "note-1"); err != nil {
		t.Fatal(err)
	}
	delivered, err := store.RecordResponse(ctx, "note-1", "different response")
	if err != nil {
		t.Fatal(err)
	}
	if !delivered.Delivered || delivered.Response != "response" {
		t.Fatalf("unexpected delivered result: %#v", delivered)
	}
}

func TestBackupCreatesConsistentSQLiteCopy(t *testing.T) {
	root := t.TempDir()
	databasePath := filepath.Join(root, "state.db")
	backupPath := filepath.Join(root, "backup.db")
	store, err := Open(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	result, err := store.CreateReview(context.Background(), "backup-note", "backup-key", Job{
		ProjectID: 10, MRIID: 5, HeadSHA: strings.Repeat("a", 40), ActorID: 42,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Backup(context.Background(), backupPath); err != nil {
		t.Fatalf("Backup() error = %v", err)
	}
	if err := store.Backup(context.Background(), backupPath); err == nil {
		t.Fatal("Backup() overwrote an existing destination")
	}
	if err := store.Backup(context.Background(), databasePath); err == nil {
		t.Fatal("Backup() accepted the source database as destination")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() == 0 {
		t.Fatal("backup database is empty")
	}
	backup, err := Open(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	defer backup.Close()
	jobID := strings.Split(result.Response, "`")[1]
	job, err := backup.GetJob(context.Background(), jobID)
	if err != nil {
		t.Fatalf("backed-up task cannot be read: %v", err)
	}
	if job.Status != StatusQueued || job.HeadSHA != strings.Repeat("a", 40) {
		t.Fatalf("unexpected restored job: %#v", job)
	}
}

func TestModelTokenBudgetReservesAndSettlesDailyUsage(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()

	day, err := store.ReserveModelTokens(ctx, 100, 60)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReserveModelTokens(ctx, 100, 41); err == nil {
		t.Fatal("reservation exceeded the remaining daily model budget")
	}
	if err := store.SettleModelTokens(ctx, day, 60, 25); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReserveModelTokens(ctx, 100, 76); err == nil {
		t.Fatal("reservation ignored settled model usage")
	}
	secondReservation, err := store.ReserveModelTokens(ctx, 100, 75)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SettleModelTokens(ctx, secondReservation, 75, 75); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReserveModelTokens(ctx, 100, 1); err == nil {
		t.Fatal("reservation succeeded after the daily budget was exhausted")
	}
}

func TestClaimNextRecordsAttemptAndEnforcesTransitions(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()

	if _, err := store.CreateReview(ctx, "note-1", "project:mr:note-1", Job{
		ProjectID: 10, MRIID: 5, HeadSHA: "0123456789abcdef0123456789abcdef01234567", ActorID: 42,
	}); err != nil {
		t.Fatal(err)
	}
	job, found, err := store.ClaimNext(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !found || job.Status != StatusPreparing || job.AttemptCount != 1 {
		t.Fatalf("unexpected claimed job: found=%t job=%#v", found, job)
	}
	if err := store.UpdateStatus(ctx, job.ID, StatusPreparing, StatusAnalyzing, ""); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateStatus(ctx, job.ID, StatusAnalyzing, StatusPublishing, ""); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateStatus(ctx, job.ID, StatusPublishing, StatusCompleted, ""); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateStatus(ctx, job.ID, StatusCompleted, StatusFailed, "late error"); err == nil {
		t.Fatal("terminal job transitioned to failed")
	}
	stored, err := store.GetJob(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != StatusCompleted || stored.AttemptCount != 1 {
		t.Fatalf("unexpected stored job: %#v", stored)
	}
}

func TestClaimNextWithLeaseRecoversExpiredAttemptAndFencesOldWorker(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()

	if _, err := store.CreateReview(ctx, "lease-note", "lease-key", Job{
		ProjectID: 10, MRIID: 5, HeadSHA: strings.Repeat("a", 40), ActorID: 42,
	}); err != nil {
		t.Fatal(err)
	}
	first, found, err := store.ClaimNextWithLease(ctx, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !found || first.LeaseToken == "" {
		t.Fatalf("first leased task = %#v, found = %t", first, found)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE jobs SET lease_until = ? WHERE id = ?`,
		time.Now().UTC().Add(-time.Minute).UnixNano(), first.ID); err != nil {
		t.Fatal(err)
	}

	second, found, err := store.ClaimNextWithLease(ctx, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !found || second.ID != first.ID || second.AttemptCount != 2 || second.LeaseToken == first.LeaseToken {
		t.Fatalf("recovered task = %#v, found = %t", second, found)
	}
	if err := store.UpdateLeasedStatus(ctx, first.ID, first.LeaseToken, StatusPreparing, StatusAnalyzing, ""); err == nil {
		t.Fatal("expired worker unexpectedly retained ownership")
	}
	if err := store.UpdateLeasedStatus(ctx, second.ID, second.LeaseToken, StatusPreparing, StatusAnalyzing, ""); err != nil {
		t.Fatalf("new worker could not advance recovered task: %v", err)
	}

	var finishedAt, attemptError string
	if err := store.db.QueryRowContext(ctx,
		`SELECT finished_at, error FROM job_attempts WHERE job_id = ? AND attempt = 1`, first.ID).
		Scan(&finishedAt, &attemptError); err != nil {
		t.Fatal(err)
	}
	if finishedAt == "" || !strings.Contains(attemptError, "will be retried") {
		t.Fatalf("expired attempt was not closed with recovery reason: finished_at=%q error=%q", finishedAt, attemptError)
	}
}

func TestExpiredPublishingLeaseFailsWithoutRetry(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()

	if _, err := store.CreateReview(ctx, "publishing-note", "publishing-key", Job{
		ProjectID: 10, MRIID: 5, HeadSHA: strings.Repeat("b", 40), ActorID: 42,
	}); err != nil {
		t.Fatal(err)
	}
	job, found, err := store.ClaimNextWithLease(ctx, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("expected task to be claimed")
	}
	if err := store.UpdateLeasedStatus(ctx, job.ID, job.LeaseToken, StatusPreparing, StatusAnalyzing, ""); err != nil {
		t.Fatal(err)
	}
	if err := store.UpdateLeasedStatus(ctx, job.ID, job.LeaseToken, StatusAnalyzing, StatusPublishing, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE jobs SET lease_until = ? WHERE id = ?`,
		time.Now().UTC().Add(-time.Minute).UnixNano(), job.ID); err != nil {
		t.Fatal(err)
	}
	var leaseUntil int64
	var leaseToken string
	if err := store.db.QueryRowContext(ctx, `SELECT lease_until, lease_token FROM jobs WHERE id = ?`, job.ID).
		Scan(&leaseUntil, &leaseToken); err != nil {
		t.Fatal(err)
	}
	if leaseUntil > time.Now().UTC().UnixNano() || leaseToken == "" {
		t.Fatalf("test failed to expire lease: until=%d token=%q now=%d", leaseUntil, leaseToken, time.Now().UTC().UnixNano())
	}

	if _, found, err := store.ClaimNextWithLease(ctx, time.Minute); err != nil {
		t.Fatal(err)
	} else if found {
		t.Fatal("publishing task was retried after its outcome became uncertain")
	}
	stored, err := store.GetJob(ctx, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != StatusFailed || !strings.Contains(stored.LastError, "outcome is uncertain") {
		t.Fatalf("expired publishing task = %#v", stored)
	}
	if err := store.RenewLease(ctx, job.ID, job.LeaseToken, time.Minute); err == nil {
		t.Fatalf("terminal job lease unexpectedly renewed: %v", err)
	}
}

func TestExpiredLeaseStopsAfterMaximumAttempts(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()

	if _, err := store.CreateReview(ctx, "attempt-limit-note", "attempt-limit-key", Job{
		ProjectID: 10, MRIID: 5, HeadSHA: strings.Repeat("c", 40), ActorID: 42,
	}); err != nil {
		t.Fatal(err)
	}
	job, found, err := store.ClaimNextWithLease(ctx, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("expected initial attempt to be claimed")
	}
	for attempt := 1; attempt <= maxJobAttempts; attempt++ {
		if job.AttemptCount != attempt {
			t.Fatalf("attempt %d claim = %#v", attempt, job)
		}
		if _, err := store.db.ExecContext(ctx, `UPDATE jobs SET lease_until = ? WHERE id = ?`,
			time.Now().UTC().Add(-time.Minute).UnixNano(), job.ID); err != nil {
			t.Fatal(err)
		}
		next, found, err := store.ClaimNextWithLease(ctx, time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		if attempt < maxJobAttempts {
			if !found {
				t.Fatalf("task was not recovered for attempt %d", attempt+1)
			}
			job = next
		} else if found {
			t.Fatal("task exceeded the configured maximum attempts")
		}
	}
	var jobID string
	if err := store.db.QueryRowContext(ctx, `SELECT id FROM jobs WHERE idempotency_key = ?`, "attempt-limit-key").
		Scan(&jobID); err != nil {
		t.Fatal(err)
	}
	stored, err := store.GetJob(ctx, jobID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != StatusFailed || stored.AttemptCount != maxJobAttempts ||
		!strings.Contains(stored.LastError, "maximum number of attempts") {
		t.Fatalf("task after attempt limit = %#v", stored)
	}
}

func TestCreateFixAuthorizationIsIdempotentAndAudited(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := context.Background()

	cases := []struct {
		eventID    string
		enabled    bool
		authorized bool
		wantText   string
		wantResult string
	}{
		{"disabled", false, true, "disabled by configuration", "denied_disabled"},
		{"unauthorized", true, false, "not authorized", "denied_not_allowlisted"},
		{"authorized", true, true, "Queued fix proposal", "authorized_queued"},
	}
	for _, test := range cases {
		job := Job{ProjectID: 10, MRIID: 5, HeadSHA: strings.Repeat("a", 40), ActorID: 42, Request: "fix null handling"}
		result, err := store.CreateFix(ctx, test.eventID, "key-"+test.eventID, job, test.enabled, test.authorized)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(result.Response, test.wantText) {
			t.Errorf("response = %q, want it to contain %q", result.Response, test.wantText)
		}
		job.ActorID = 99
		retry, err := store.CreateFix(ctx, test.eventID, "key-"+test.eventID, job,
			!test.enabled, !test.authorized)
		if err != nil {
			t.Fatal(err)
		}
		if retry.Response != result.Response {
			t.Errorf("idempotent retry response = %q, want %q", retry.Response, result.Response)
		}
		var auditResult string
		err = store.db.QueryRowContext(ctx,
			`SELECT result FROM audit_events WHERE resource = ? AND actor_id = ? ORDER BY id DESC LIMIT 1`,
			"10:5", 42).Scan(&auditResult)
		if err != nil {
			t.Fatal(err)
		}
		if auditResult != test.wantResult {
			t.Errorf("audit result = %q, want %q", auditResult, test.wantResult)
		}
	}

	var auditCount int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM audit_events WHERE action = 'request_fix'`).
		Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != len(cases) {
		t.Fatalf("fix audit entries = %d, want %d", auditCount, len(cases))
	}
	var jobCount int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM jobs WHERE type = ?`, TypeFix).Scan(&jobCount); err != nil {
		t.Fatal(err)
	}
	if jobCount != 1 {
		t.Fatalf("fix jobs = %d, want only the authorized task", jobCount)
	}
	job, found, err := store.ClaimNext(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !found || job.Type != TypeFix || job.Request != "fix null handling" {
		t.Fatalf("claimed fix task = %#v, found = %t", job, found)
	}
}

func TestFixLifecycleTransitionsAreExplicit(t *testing.T) {
	transitions := [][2]string{
		{StatusQueued, StatusPreparing},
		{StatusPreparing, StatusAnalyzing},
		{StatusAnalyzing, StatusFixing},
		{StatusFixing, StatusVerifying},
		{StatusVerifying, StatusPublishing},
		{StatusPublishing, StatusCompleted},
	}
	for _, transition := range transitions {
		if !validTransition(transition[0], transition[1]) {
			t.Errorf("validTransition(%q, %q) = false", transition[0], transition[1])
		}
	}
	for _, transition := range [][2]string{
		{StatusFixing, StatusPublishing},
		{StatusVerifying, StatusFixing},
		{StatusCompleted, StatusFixing},
	} {
		if validTransition(transition[0], transition[1]) {
			t.Errorf("validTransition(%q, %q) = true", transition[0], transition[1])
		}
	}
}
