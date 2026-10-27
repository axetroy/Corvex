package jobs

import (
	"context"
	"strings"
	"testing"
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

func TestRecordFixAuthorizationIsIdempotentAndAudited(t *testing.T) {
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
		{"authorized", true, true, "No task was queued", "authorized_executor_unavailable"},
	}
	for _, test := range cases {
		result, err := store.RecordFixAuthorization(ctx, test.eventID, 10, 5, 42,
			test.enabled, test.authorized)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(result.Response, test.wantText) {
			t.Errorf("response = %q, want it to contain %q", result.Response, test.wantText)
		}
		retry, err := store.RecordFixAuthorization(ctx, test.eventID, 10, 5, 99,
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
