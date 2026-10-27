package git

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestValidateWorkspaceFilePathUsesGitPathSeparators(t *testing.T) {
	for _, filePath := range []string{"main.go", "internal/app/server.go"} {
		if err := validateWorkspaceFilePath(filePath); err != nil {
			t.Errorf("valid repository path %q rejected: %v", filePath, err)
		}
	}
	for _, filePath := range []string{
		"", ".", "..", "../secret", "internal/../secret", "/etc/passwd", `C:\Windows\win.ini`,
		`internal\server.go`, "internal//server.go", "file\x00name",
	} {
		if err := validateWorkspaceFilePath(filePath); err == nil {
			t.Errorf("invalid repository path %q accepted", filePath)
		}
	}
}

func TestPrepareWorkspaceDiffReadAndCleanup(t *testing.T) {
	requireGit(t)
	root := t.TempDir()
	source := filepath.Join(root, "source")
	runGit(t, root, "init", "-b", "main", source)
	runGit(t, source, "config", "user.name", "Corvex Test")
	runGit(t, source, "config", "user.email", "corvex@example.test")
	writeFile(t, filepath.Join(source, "main.go"), "package sample\n\nfunc Value() int { return 1 }\n")
	runGit(t, source, "add", ".")
	runGit(t, source, "commit", "-m", "base")
	baseSHA := strings.TrimSpace(string(runGit(t, source, "rev-parse", "HEAD")))

	writeFile(t, filepath.Join(source, "main.go"), "package sample\n\nfunc Value() int { return 2 }\n")
	writeFile(t, filepath.Join(source, "asset.bin"), string([]byte{0, 1, 2, 3}))
	runGit(t, source, "add", ".")
	runGit(t, source, "commit", "-m", "change")
	headSHA := strings.TrimSpace(string(runGit(t, source, "rev-parse", "HEAD")))

	serveRoot := filepath.Join(root, "http")
	bareRepo := filepath.Join(serveRoot, "sample.git")
	if err := os.MkdirAll(serveRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	runGit(t, root, "clone", "--bare", source, bareRepo)
	runGit(t, root, "--git-dir", bareRepo, "update-server-info")
	server := httptest.NewServer(http.FileServer(http.Dir(serveRoot)))
	defer server.Close()

	manager, err := NewManager(filepath.Join(root, "corvex"), server.URL, "read-token")
	if err != nil {
		t.Fatal(err)
	}
	repositoryURL := server.URL + "/sample.git"
	workspace, err := manager.PrepareWorkspace(context.Background(), 44, "task-one", repositoryURL, headSHA)
	if err != nil {
		t.Fatalf("PrepareWorkspace() error = %v", err)
	}
	if workspace.HeadSHA != headSHA {
		t.Fatalf("workspace SHA = %s, want %s", workspace.HeadSHA, headSHA)
	}
	actualSHA := strings.TrimSpace(string(runGit(t, workspace.Path, "rev-parse", "HEAD")))
	if actualSHA != headSHA {
		t.Fatalf("checked out SHA = %s, want %s", actualSHA, headSHA)
	}

	diff, err := manager.Diff(context.Background(), workspace, baseSHA, 10, 1<<20)
	if err != nil {
		t.Fatalf("Diff() error = %v", err)
	}
	if len(diff.Changes) != 2 || diff.SkippedFiles != 1 {
		t.Fatalf("unexpected diff result: %#v", diff)
	}
	if diff.Changes[0].Path != "asset.bin" || diff.Changes[0].Skipped != "binary file" {
		t.Fatalf("binary change was not skipped: %#v", diff.Changes[0])
	}
	if !strings.Contains(diff.Changes[1].Patch, "-func Value() int { return 1 }") {
		t.Fatalf("text patch missing expected old line: %#v", diff.Changes[1])
	}
	limitedDiff, err := manager.Diff(context.Background(), workspace, baseSHA, 1, 1<<20)
	if err != nil {
		t.Fatalf("Diff() with file limit error = %v", err)
	}
	if len(limitedDiff.Changes) != 1 || limitedDiff.SkippedFiles != 2 {
		t.Fatalf("file limit was not enforced: %#v", limitedDiff)
	}

	content, err := manager.ReadFile(context.Background(), workspace, "main.go", 1024)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if !strings.Contains(string(content), "return 2") {
		t.Fatalf("ReadFile() returned unexpected content: %s", content)
	}
	if _, err := manager.ReadFile(context.Background(), workspace, "../outside", 1024); err == nil {
		t.Fatal("ReadFile accepted a path outside the workspace")
	}
	if _, err := manager.ReadFile(context.Background(), workspace, "main.go", 4); err == nil {
		t.Fatal("ReadFile ignored the byte limit")
	}
	symlinkPath := filepath.Join(workspace.Path, "external-link")
	if err := os.Symlink("/etc/passwd", symlinkPath); err != nil {
		if runtime.GOOS != "windows" {
			t.Fatal(err)
		}
		t.Logf("skipping symlink escape check because Windows did not permit creating the test symlink: %v", err)
	} else {
		if _, err := manager.ReadFile(context.Background(), workspace, "external-link", 1024); err == nil {
			t.Fatal("ReadFile followed a symlink outside the workspace")
		}
		if err := os.Remove(symlinkPath); err != nil {
			t.Fatal(err)
		}
	}
	dirtyMarker := filepath.Join(workspace.Path, "dirty-marker")
	if err := os.WriteFile(dirtyMarker, []byte("dirty"), 0o600); err != nil {
		t.Fatal(err)
	}
	patch := "diff --git a/main.go b/main.go\n--- a/main.go\n+++ b/main.go\n@@ -3 +3 @@\n-func Value() int { return 2 }\n+func Value() int { return 3 }\n"
	if _, err := manager.ApplyPatch(context.Background(), workspace, patch, []string{"main.go"}, 16<<10); err == nil {
		t.Fatal("ApplyPatch accepted a dirty worktree")
	}
	if err := os.Remove(dirtyMarker); err != nil {
		t.Fatal(err)
	}
	applied, err := manager.ApplyPatch(context.Background(), workspace, patch, []string{"main.go"}, 16<<10)
	if err != nil {
		t.Fatalf("ApplyPatch() error = %v", err)
	}
	if !strings.Contains(applied, "+func Value() int { return 3 }") {
		t.Fatalf("returned patch does not describe the applied change: %s", applied)
	}
	patchedFile, err := os.ReadFile(filepath.Join(workspace.Path, "main.go"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(patchedFile), "return 3") {
		t.Fatalf("patch was not applied to isolated workspace: %s", patchedFile)
	}
	unauthorizedPatch := "diff --git a/other.go b/other.go\n--- a/other.go\n+++ b/other.go\n@@ -1 +1 @@\n-before\n+after\n"
	if _, err := manager.ApplyPatch(context.Background(), workspace, unauthorizedPatch, []string{"main.go"}, 16<<10); err == nil {
		t.Fatal("ApplyPatch accepted a path outside the authorized MR diff")
	}

	other, err := manager.PrepareWorkspace(context.Background(), 44, "task-two", repositoryURL, baseSHA)
	if err != nil {
		t.Fatalf("prepare second workspace: %v", err)
	}
	if other.Path == workspace.Path {
		t.Fatal("separate tasks received the same workspace path")
	}
	if err := manager.CleanupWorkspace(context.Background(), workspace); err != nil {
		t.Fatalf("CleanupWorkspace() error = %v", err)
	}
	if _, err := os.Stat(workspace.Path); !os.IsNotExist(err) {
		t.Fatalf("workspace still exists after cleanup: %v", err)
	}
	if err := manager.CleanupWorkspace(context.Background(), other); err != nil {
		t.Fatalf("cleanup second workspace: %v", err)
	}
}

func TestValidateFixPatchRejectsUnsupportedChanges(t *testing.T) {
	allowed := []string{"main.go"}
	for _, patch := range []string{
		"diff --git a/main.go b/other.go\n--- a/main.go\n+++ b/other.go\n@@ -1 +1 @@\n-old\n+new\n",
		"diff --git a/other.go b/other.go\n--- a/other.go\n+++ b/other.go\n@@ -1 +1 @@\n-old\n+new\n",
		"diff --git a/main.go b/main.go\nnew file mode 100644\n--- /dev/null\n+++ b/main.go\n@@ -0,0 +1 @@\n+new\n",
		"diff --git a/.git/config b/.git/config\n--- a/.git/config\n+++ b/.git/config\n@@ -1 +1 @@\n-old\n+new\n",
	} {
		if _, err := validateFixPatch(patch, allowed); err == nil {
			t.Errorf("validateFixPatch accepted unsupported patch %q", patch)
		}
	}
}

func TestIsRegularBlobRejectsSymlinksAndSubmodules(t *testing.T) {
	for _, testCase := range []struct {
		entry string
		path  string
	}{
		{entry: "120000 blob deadbeef\tlink\x00", path: "link"},
		{entry: "160000 commit deadbeef\tsubmodule\x00", path: "submodule"},
		{entry: "100644 tree deadbeef\tfolder\x00", path: "folder"},
	} {
		if isRegularBlob([]byte(testCase.entry), testCase.path) {
			t.Errorf("isRegularBlob accepted non-regular entry %q", testCase.entry)
		}
	}
	if !isRegularBlob([]byte("100644 blob deadbeef\tmain.go\x00"), "main.go") {
		t.Fatal("isRegularBlob rejected a regular tracked file")
	}
}

func TestRepositoryURLMustMatchConfiguredGitLab(t *testing.T) {
	manager, err := NewManager(t.TempDir(), "https://gitlab.example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{
		"https://evil.example.test/group/repo.git",
		"https://user:password@gitlab.example.test/group/repo.git",
		"https://gitlab.example.test/group/../repo.git",
		"https://gitlab.example.test/group/repo.git?token=secret",
		"http://gitlab.example.test/group/repo.git",
	} {
		if _, err := manager.validateRepositoryURL(invalid); err == nil {
			t.Errorf("validateRepositoryURL(%q) unexpectedly succeeded", invalid)
		}
	}
}

func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git executable is not installed")
	}
}

func runGit(t *testing.T, dir string, args ...string) []byte {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, output)
	}
	return output
}

func writeFile(t *testing.T, name, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}
