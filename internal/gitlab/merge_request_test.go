package gitlab

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

func TestGetMergeRequestAndPaginatedDiff(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("PRIVATE-TOKEN") != "api-token" {
			t.Error("PRIVATE-TOKEN header missing")
		}
		switch r.URL.Path {
		case "/api/v4/projects/10":
			_, _ = w.Write([]byte(`{"id":10,"http_url_to_repo":"https://gitlab.example.test/group/project.git"}`))
		case "/api/v4/projects/10/merge_requests/8":
			_, _ = w.Write([]byte(`{"iid":8,"state":"opened","source_branch":"feature","target_branch":"main","sha":"abc","diff_refs":{"base_sha":"base","head_sha":"head"}}`))
		case "/api/v4/projects/10/merge_requests/8/diffs":
			requests++
			page, err := strconv.Atoi(r.URL.Query().Get("page"))
			if err != nil {
				t.Errorf("page query is invalid: %v", err)
			}
			changes := make([]MergeRequestDiff, 0)
			if page == 1 {
				for i := 0; i < 100; i++ {
					changes = append(changes, MergeRequestDiff{NewPath: fmt.Sprintf("file-%03d.go", i)})
				}
				w.Header().Set("X-Next-Page", "2")
			} else if page == 2 {
				changes = append(changes, MergeRequestDiff{NewPath: "last.go"})
			} else {
				t.Errorf("unexpected diff page %d", page)
			}
			_ = json.NewEncoder(w).Encode(changes)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client, err := NewClient(server.URL, "api-token")
	if err != nil {
		t.Fatal(err)
	}
	project, err := client.GetProject(context.Background(), 10)
	if err != nil {
		t.Fatalf("GetProject() error = %v", err)
	}
	if project.HTTPURLToRepo != "https://gitlab.example.test/group/project.git" {
		t.Fatalf("unexpected project response: %#v", project)
	}
	mr, err := client.GetMergeRequest(context.Background(), 10, 8)
	if err != nil {
		t.Fatalf("GetMergeRequest() error = %v", err)
	}
	if mr.HeadSHA() != "head" || mr.SourceBranch != "feature" {
		t.Fatalf("unexpected MR response: %#v", mr)
	}
	changes, err := client.GetMergeRequestDiff(context.Background(), 10, 8)
	if err != nil {
		t.Fatalf("GetMergeRequestDiff() error = %v", err)
	}
	if len(changes) != 101 || requests != 2 {
		t.Fatalf("unexpected paginated diff: len=%d requests=%d", len(changes), requests)
	}
	if changes[100].NewPath != "last.go" {
		t.Fatalf("last diff entry = %#v, want last.go", changes[100])
	}
}

func TestMergeRequestMethodsRejectInvalidIDs(t *testing.T) {
	client, err := NewClient("https://gitlab.example.test", "token")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.GetMergeRequest(context.Background(), 0, 1); err == nil {
		t.Fatal("GetMergeRequest accepted a non-positive project ID")
	}
	if _, err := client.GetMergeRequestDiff(context.Background(), 1, 0); err == nil {
		t.Fatal("GetMergeRequestDiff accepted a non-positive MR IID")
	}
}

func TestReadAndWriteTokensAreSeparated(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		want := "read-token"
		if r.Method == http.MethodPost {
			want = "write-token"
		}
		if got := r.Header.Get("PRIVATE-TOKEN"); got != want {
			t.Errorf("%s %s token = %q, want %q", r.Method, r.URL.Path, got, want)
		}
		if r.Method == http.MethodPost {
			w.WriteHeader(http.StatusCreated)
			return
		}
		_, _ = w.Write([]byte(`{"id":10,"http_url_to_repo":"https://gitlab.example.test/p.git"}`))
	}))
	defer server.Close()

	client, err := NewClientWithTokens(server.URL, "read-token", "write-token")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.GetProject(context.Background(), 10); err != nil {
		t.Fatalf("GetProject() error = %v", err)
	}
	if err := client.PostNote(context.Background(), 10, 8, "feedback"); err != nil {
		t.Fatalf("PostNote() error = %v", err)
	}
}
