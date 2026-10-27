package git

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const maxTotalDiffBytes = 16 << 20
const maxFixPatchBytes = 256 << 10

type Change struct {
	Path         string `json:"path"`
	Status       string `json:"status"`
	AddedLines   int    `json:"added_lines"`
	RemovedLines int    `json:"removed_lines"`
	Patch        string `json:"patch,omitempty"`
	Skipped      string `json:"skipped,omitempty"`
}

type DiffResult struct {
	BaseSHA      string   `json:"base_sha"`
	HeadSHA      string   `json:"head_sha"`
	Changes      []Change `json:"changes"`
	SkippedFiles int      `json:"skipped_files"`
}

func (m *Manager) Diff(
	ctx context.Context,
	workspace Workspace,
	baseSHA string,
	maxFiles int,
	maxFileDiffBytes int,
) (DiffResult, error) {
	if err := m.validateWorkspace(workspace); err != nil {
		return DiffResult{}, err
	}
	if !shaPattern.MatchString(baseSHA) || !shaPattern.MatchString(workspace.HeadSHA) {
		return DiffResult{}, errors.New("diff requires full commit SHAs")
	}
	if maxFiles <= 0 || maxFiles > 1000 {
		return DiffResult{}, errors.New("maxFiles must be between 1 and 1000")
	}
	if maxFileDiffBytes <= 0 || maxFileDiffBytes > maxTotalDiffBytes {
		return DiffResult{}, fmt.Errorf("maxFileDiffBytes must be between 1 and %d", maxTotalDiffBytes)
	}

	nameOutput, nameTruncated, err := m.run(ctx, workspace.Path, maxTotalDiffBytes, "diff",
		"--no-ext-diff", "--no-renames", "--name-status", "-z", baseSHA, workspace.HeadSHA, "--")
	if err != nil {
		return DiffResult{}, fmt.Errorf("list changed files: %w", err)
	}
	if nameTruncated {
		return DiffResult{}, errors.New("changed file list exceeds output limit")
	}
	files, err := parseNameStatus(nameOutput)
	if err != nil {
		return DiffResult{}, err
	}
	numstatOutput, numstatTruncated, err := m.run(ctx, workspace.Path, maxTotalDiffBytes, "diff",
		"--no-ext-diff", "--no-renames", "--numstat", "-z", baseSHA, workspace.HeadSHA, "--")
	if err != nil {
		return DiffResult{}, fmt.Errorf("read diff statistics: %w", err)
	}
	if numstatTruncated {
		return DiffResult{}, errors.New("diff statistics exceed output limit")
	}
	stats, err := parseNumstat(numstatOutput)
	if err != nil {
		return DiffResult{}, err
	}

	result := DiffResult{BaseSHA: baseSHA, HeadSHA: workspace.HeadSHA}
	totalBytes := 0
	for index, file := range files {
		if index >= maxFiles {
			result.SkippedFiles++
			continue
		}
		stat, found := stats[file.Path]
		if !found {
			return DiffResult{}, fmt.Errorf("Git returned no statistics for changed file %q", file.Path)
		}
		if stat.binary {
			file.Skipped = "binary file"
			result.Changes = append(result.Changes, file)
			result.SkippedFiles++
			continue
		}
		file.AddedLines = stat.added
		file.RemovedLines = stat.removed
		remaining := maxTotalDiffBytes - totalBytes
		fileLimit := maxFileDiffBytes
		if remaining < fileLimit {
			fileLimit = remaining
		}
		if fileLimit <= 0 {
			file.Skipped = "total diff size limit exceeded"
			result.Changes = append(result.Changes, file)
			result.SkippedFiles++
			continue
		}
		patch, truncated, err := m.run(ctx, workspace.Path, fileLimit, "diff", "--no-ext-diff", "--unified=3",
			baseSHA, workspace.HeadSHA, "--", file.Path)
		if err != nil {
			return DiffResult{}, fmt.Errorf("read diff for %q: %w", file.Path, err)
		}
		if truncated {
			file.Skipped = "file diff size limit exceeded"
			result.Changes = append(result.Changes, file)
			result.SkippedFiles++
			continue
		}
		file.Patch = string(patch)
		totalBytes += len(patch)
		result.Changes = append(result.Changes, file)
	}
	return result, nil
}

func (m *Manager) ReadFile(ctx context.Context, workspace Workspace, name string, maxBytes int64) ([]byte, error) {
	if err := m.validateWorkspace(workspace); err != nil {
		return nil, err
	}
	if maxBytes <= 0 || maxBytes > maxReadFileBytes {
		return nil, fmt.Errorf("maxBytes must be between 1 and %d", maxReadFileBytes)
	}
	if filepath.IsAbs(name) || strings.Contains(name, "\\") || filepath.Clean(name) != name ||
		name == "." || name == ".." || strings.HasPrefix(name, ".."+string(filepath.Separator)) {
		return nil, errors.New("file path must be relative to the workspace")
	}
	content, truncated, err := m.run(ctx, workspace.Path, int(maxBytes), "cat-file", "blob", workspace.HeadSHA+":"+name)
	if err != nil {
		return nil, fmt.Errorf("read file %q at pinned commit: %w", name, err)
	}
	if truncated {
		return nil, fmt.Errorf("file exceeds %d-byte read limit", maxBytes)
	}
	return content, nil
}

func (m *Manager) ApplyPatch(
	ctx context.Context,
	workspace Workspace,
	patch string,
	allowedPaths []string,
	maxPatchBytes int,
) (string, error) {
	if err := m.validateWorkspace(workspace); err != nil {
		return "", err
	}
	if maxPatchBytes <= 0 || maxPatchBytes > maxFixPatchBytes || len(patch) == 0 || len(patch) > maxPatchBytes {
		return "", errors.New("fix patch is empty or exceeds its configured size limit")
	}
	paths, err := validateFixPatch(patch, allowedPaths)
	if err != nil {
		return "", err
	}
	status, _, err := m.run(ctx, workspace.Path, maxErrorOutput, "status", "--porcelain", "--untracked-files=all")
	if err != nil {
		return "", fmt.Errorf("check worktree before patch: %w", err)
	}
	if len(status) != 0 {
		return "", errors.New("patch worktree is not clean")
	}
	for _, name := range paths {
		treeEntry, _, err := m.run(ctx, workspace.Path, maxErrorOutput, "ls-tree", "-z", "HEAD", "--", name)
		if err != nil {
			return "", fmt.Errorf("inspect patch target %q: %w", name, err)
		}
		if !isRegularBlob(treeEntry, name) {
			return "", fmt.Errorf("patch target %q is not a regular tracked file", name)
		}
	}
	if _, _, err := m.runInput(ctx, workspace.Path, maxErrorOutput, []byte(patch),
		"apply", "--check", "--whitespace=error", "-"); err != nil {
		return "", fmt.Errorf("check generated patch: %w", err)
	}
	if _, _, err := m.runInput(ctx, workspace.Path, maxErrorOutput, []byte(patch),
		"apply", "--whitespace=error", "-"); err != nil {
		return "", fmt.Errorf("apply generated patch: %w", err)
	}
	if _, _, err := m.run(ctx, workspace.Path, maxErrorOutput, "diff", "--check", "HEAD", "--"); err != nil {
		return "", fmt.Errorf("check patched worktree: %w", err)
	}
	changed, truncated, err := m.run(ctx, workspace.Path, maxFixPatchBytes, "diff", "--name-only", "-z", "HEAD", "--")
	if err != nil {
		return "", fmt.Errorf("list patched files: %w", err)
	}
	if truncated {
		return "", errors.New("patched file list exceeds output limit")
	}
	if err := validateAppliedPaths(changed, paths); err != nil {
		return "", err
	}
	finalPatch, truncated, err := m.run(ctx, workspace.Path, maxPatchBytes, "diff", "--no-ext-diff", "--unified=3", "HEAD", "--")
	if err != nil {
		return "", fmt.Errorf("read validated patch: %w", err)
	}
	if truncated {
		return "", errors.New("validated patch exceeds configured size limit")
	}
	if len(finalPatch) == 0 {
		return "", errors.New("generated patch produced no worktree changes")
	}
	return string(finalPatch), nil
}

func validateFixPatch(patch string, allowedPaths []string) ([]string, error) {
	allowed := make(map[string]struct{}, len(allowedPaths))
	for _, name := range allowedPaths {
		if !validPatchPath(name) {
			return nil, fmt.Errorf("invalid authorized patch path %q", name)
		}
		allowed[name] = struct{}{}
	}
	if len(allowed) == 0 {
		return nil, errors.New("fix patch has no authorized changed files")
	}
	lines := strings.Split(patch, "\n")
	var paths []string
	seen := make(map[string]struct{})
	for index := 0; index < len(lines); {
		header := strings.TrimSuffix(lines[index], "\r")
		if !strings.HasPrefix(header, "diff --git ") {
			if strings.TrimSpace(header) == "" && len(paths) == 0 {
				index++
				continue
			}
			return nil, errors.New("fix patch contains data outside a git diff section")
		}
		sectionStart := index
		index++
		for index < len(lines) && !strings.HasPrefix(lines[index], "diff --git ") {
			index++
		}
		section := lines[sectionStart:index]
		oldPath, newPath, hasHunk := "", "", false
		for _, rawLine := range section {
			line := strings.TrimSuffix(rawLine, "\r")
			switch {
			case strings.HasPrefix(line, "--- a/"):
				oldPath = patchFilePath(strings.TrimPrefix(line, "--- a/"))
			case strings.HasPrefix(line, "+++ b/"):
				newPath = patchFilePath(strings.TrimPrefix(line, "+++ b/"))
			case strings.HasPrefix(line, "@@ "):
				hasHunk = true
			case strings.HasPrefix(line, "new file mode "), strings.HasPrefix(line, "deleted file mode "),
				strings.HasPrefix(line, "old mode "), strings.HasPrefix(line, "new mode "),
				strings.HasPrefix(line, "rename from "), strings.HasPrefix(line, "rename to "),
				strings.HasPrefix(line, "copy from "), strings.HasPrefix(line, "copy to "),
				line == "GIT binary patch", strings.HasPrefix(line, "Binary files "):
				return nil, errors.New("fix patch may only modify existing text files")
			}
		}
		if oldPath == "" || newPath == "" || oldPath != newPath || !hasHunk || !validPatchPath(oldPath) {
			return nil, errors.New("fix patch contains an unsupported or malformed file change")
		}
		if !strings.HasPrefix(header, "diff --git a/") ||
			strings.TrimPrefix(header, "diff --git a/") != oldPath+" b/"+newPath {
			return nil, errors.New("fix patch header does not match its file paths")
		}
		if _, ok := allowed[oldPath]; !ok {
			return nil, fmt.Errorf("fix patch targets unauthorized file %q", oldPath)
		}
		if _, duplicate := seen[oldPath]; duplicate {
			return nil, fmt.Errorf("fix patch contains duplicate file section %q", oldPath)
		}
		seen[oldPath] = struct{}{}
		paths = append(paths, oldPath)
	}
	if len(paths) == 0 {
		return nil, errors.New("fix patch contains no file changes")
	}
	return paths, nil
}

func patchFilePath(value string) string {
	if timestamp := strings.IndexByte(value, '\t'); timestamp >= 0 {
		return value[:timestamp]
	}
	return value
}

func validPatchPath(name string) bool {
	if name == "" || filepath.IsAbs(name) || strings.Contains(name, "\\") ||
		filepath.Clean(name) != name || name == "." || name == ".." ||
		strings.HasPrefix(name, ".."+string(filepath.Separator)) ||
		name == ".git" || strings.HasPrefix(name, ".git"+string(filepath.Separator)) {
		return false
	}
	return true
}

func isRegularBlob(output []byte, expectedPath string) bool {
	entry := bytes.TrimSuffix(output, []byte{0})
	tab := bytes.IndexByte(entry, '\t')
	if tab < 0 || string(entry[tab+1:]) != expectedPath {
		return false
	}
	fields := strings.Fields(string(entry[:tab]))
	return len(fields) == 3 && (fields[0] == "100644" || fields[0] == "100755") && fields[1] == "blob"
}

func validateAppliedPaths(output []byte, expected []string) error {
	allowed := make(map[string]struct{}, len(expected))
	for _, name := range expected {
		allowed[name] = struct{}{}
	}
	fields := bytes.Split(output, []byte{0})
	seen := make(map[string]struct{}, len(fields))
	for _, field := range fields {
		if len(field) == 0 {
			continue
		}
		name := string(field)
		if !validPatchPath(name) {
			return fmt.Errorf("git reported unsafe patched path %q", name)
		}
		if _, ok := allowed[name]; !ok {
			return fmt.Errorf("generated patch changed unauthorized file %q", name)
		}
		seen[name] = struct{}{}
	}
	if len(seen) == 0 {
		return errors.New("generated patch did not modify any files")
	}
	return nil
}

func (m *Manager) validateWorkspace(workspace Workspace) error {
	if workspace.ProjectID <= 0 || !idPattern.MatchString(workspace.JobID) {
		return errors.New("invalid workspace identity")
	}
	expected := filepath.Join(m.workspaceRoot, fmt.Sprintf("%d", workspace.ProjectID), workspace.JobID)
	if filepath.Clean(workspace.Path) != expected {
		return errors.New("workspace path does not match its managed location")
	}
	info, err := os.Lstat(expected)
	if err != nil {
		return fmt.Errorf("inspect workspace: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("workspace is not a directory")
	}
	gitFile := filepath.Join(expected, ".git")
	gitFileInfo, err := os.Lstat(gitFile)
	if err != nil || !gitFileInfo.Mode().IsRegular() {
		return errors.New("workspace has an invalid Git worktree marker")
	}
	gitFileContents, err := os.ReadFile(gitFile)
	if err != nil {
		return fmt.Errorf("read workspace Git marker: %w", err)
	}
	const marker = "gitdir: "
	markerContents := strings.TrimSpace(string(gitFileContents))
	if !strings.HasPrefix(markerContents, marker) {
		return errors.New("workspace Git marker is malformed")
	}
	actualGitDir := strings.TrimPrefix(markerContents, marker)
	if !filepath.IsAbs(actualGitDir) {
		actualGitDir = filepath.Join(expected, actualGitDir)
	}
	actualGitDir, err = filepath.EvalSymlinks(actualGitDir)
	if err != nil {
		return fmt.Errorf("resolve workspace Git metadata: %w", err)
	}
	expectedGitDir := filepath.Join(m.mirrorRoot, fmt.Sprintf("%d.git", workspace.ProjectID), "worktrees", workspace.JobID)
	expectedGitDir, err = filepath.EvalSymlinks(expectedGitDir)
	if err != nil {
		return fmt.Errorf("resolve expected Git metadata: %w", err)
	}
	if actualGitDir != expectedGitDir {
		return errors.New("workspace belongs to a different project or job")
	}
	return nil
}

func parseNameStatus(output []byte) ([]Change, error) {
	fields := bytes.Split(output, []byte{0})
	if len(fields) > 0 && len(fields[len(fields)-1]) == 0 {
		fields = fields[:len(fields)-1]
	}
	if len(fields)%2 != 0 {
		return nil, errors.New("Git returned malformed name-status data")
	}
	changes := make([]Change, 0, len(fields)/2)
	for index := 0; index < len(fields); index += 2 {
		status := string(fields[index])
		name := string(fields[index+1])
		clean := filepath.Clean(name)
		if name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, "\\") ||
			clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return nil, fmt.Errorf("Git returned unsafe path %q", name)
		}
		changes = append(changes, Change{Path: name, Status: status})
	}
	return changes, nil
}

type fileStat struct {
	added   int
	removed int
	binary  bool
}

func parseNumstat(output []byte) (map[string]fileStat, error) {
	fields := bytes.Split(output, []byte{0})
	if len(fields) > 0 && len(fields[len(fields)-1]) == 0 {
		fields = fields[:len(fields)-1]
	}
	stats := make(map[string]fileStat, len(fields))
	for _, field := range fields {
		parts := bytes.SplitN(field, []byte{'\t'}, 3)
		if len(parts) != 3 || len(parts[2]) == 0 {
			return nil, errors.New("Git returned malformed numstat data")
		}
		name := string(parts[2])
		stat := fileStat{}
		if string(parts[0]) == "-" || string(parts[1]) == "-" {
			stat.binary = true
		} else {
			added, err := strconv.Atoi(string(parts[0]))
			if err != nil {
				return nil, fmt.Errorf("parse added line count for %q: %w", name, err)
			}
			removed, err := strconv.Atoi(string(parts[1]))
			if err != nil {
				return nil, fmt.Errorf("parse removed line count for %q: %w", name, err)
			}
			stat.added, stat.removed = added, removed
		}
		stats[name] = stat
	}
	return stats, nil
}
