package fix

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/axetroy/corvex/internal/agent"
	gitengine "github.com/axetroy/corvex/internal/git"
	"github.com/axetroy/corvex/internal/review"
)

func TestWorkflowReturnsBoundedPatchAndUsage(t *testing.T) {
	patch := "diff --git a/main.go b/main.go\n--- a/main.go\n+++ b/main.go\n@@ -1 +1 @@\n-return 1\n+return 2\n"
	model := &fakeModel{response: agent.ModelResponse{
		Model: "fix-model", Content: `{"summary":"Correct the return value.","patch":` + mustJSONString(t, patch) + `}`,
		Usage: agent.ModelUsage{InputTokens: 10, OutputTokens: 20, TotalTokens: 30},
	}}
	workflow, err := NewWorkflow(model, 1<<20, 1<<10)
	if err != nil {
		t.Fatal(err)
	}
	diff := sampleDiff()
	outcome, err := workflow.Fix(context.Background(), review.Context{
		ProjectID: 1, MRIID: 2, BaseSHA: diff.BaseSHA, HeadSHA: diff.HeadSHA,
	}, "Fix the calculation", diff)
	if err != nil {
		t.Fatalf("Fix() error = %v", err)
	}
	if outcome.Patch != patch || outcome.Summary != "Correct the return value." ||
		outcome.Model != "fix-model" || outcome.Usage.TotalTokens != 30 {
		t.Fatalf("unexpected fix outcome: %#v", outcome)
	}
	if !strings.Contains(model.request.SystemPrompt, "untrusted data") ||
		!strings.Contains(model.request.UserPrompt, "Fix the calculation") {
		t.Fatalf("fix prompt did not preserve the trust boundary: %#v", model.request)
	}
}

func TestWorkflowRejectsMalformedOrOversizedModelOutput(t *testing.T) {
	for _, response := range []string{
		"```json\n{\"summary\":\"ok\",\"patch\":\"\"}\n```",
		`{"summary":"ok","patch":"","unexpected":true}`,
		`{"summary":"ok","patch":""} trailing`,
		`{"summary":"","patch":""}`,
	} {
		if _, err := parseResponse(response, 100); err == nil {
			t.Errorf("parseResponse(%q) unexpectedly succeeded", response)
		}
	}
	if _, err := parseResponse(`{"summary":"ok","patch":"12345"}`, 4); err == nil {
		t.Fatal("parseResponse accepted an oversized patch")
	}
}

func TestWorkflowRejectsMismatchedDiffWithoutCallingModel(t *testing.T) {
	model := &fakeModel{}
	workflow, err := NewWorkflow(model, 1<<20, 1<<10)
	if err != nil {
		t.Fatal(err)
	}
	diff := sampleDiff()
	_, err = workflow.Fix(context.Background(), review.Context{
		ProjectID: 1, MRIID: 2, BaseSHA: diff.BaseSHA, HeadSHA: strings.Repeat("c", 40),
	}, "", diff)
	if err == nil || model.called {
		t.Fatalf("Fix() mismatch error = %v, model called = %t", err, model.called)
	}
}

type fakeModel struct {
	response agent.ModelResponse
	request  agent.ModelRequest
	called   bool
}

func (m *fakeModel) Generate(_ context.Context, request agent.ModelRequest) (agent.ModelResponse, error) {
	m.called = true
	m.request = request
	return m.response, nil
}

func sampleDiff() gitengine.DiffResult {
	return gitengine.DiffResult{
		BaseSHA: strings.Repeat("a", 40), HeadSHA: strings.Repeat("b", 40),
		Changes: []gitengine.Change{{
			Path: "main.go", Status: "M", Patch: "@@ -1 +1 @@\n-return 1\n+return 2\n",
		}},
	}
}

func mustJSONString(t *testing.T, value string) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}
