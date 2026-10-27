package jobs

import "time"

const (
	TypeReview       = "review"
	TypeFix          = "fix"
	TypeExplain      = "explain"
	StatusQueued     = "queued"
	StatusPreparing  = "preparing"
	StatusAnalyzing  = "analyzing"
	StatusFixing     = "fixing"
	StatusVerifying  = "verifying"
	StatusPublishing = "publishing"
	StatusCompleted  = "completed"
	StatusFailed     = "failed"
	StatusStale      = "stale"
	StatusCancelled  = "cancelled"
)

type Job struct {
	ID           string    `json:"id"`
	Type         string    `json:"type"`
	Status       string    `json:"status"`
	ProjectID    int64     `json:"project_id"`
	MRIID        int64     `json:"mr_iid"`
	HeadSHA      string    `json:"head_sha,omitempty"`
	ActorID      int64     `json:"actor_id"`
	Request      string    `json:"request,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	AttemptCount int       `json:"attempt_count,omitempty"`
	LastError    string    `json:"last_error,omitempty"`
	LeaseToken   string    `json:"-"`
}

type EventResult struct {
	Response  string
	Delivered bool
}
