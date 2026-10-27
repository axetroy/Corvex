package jobs

import (
	"context"
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
