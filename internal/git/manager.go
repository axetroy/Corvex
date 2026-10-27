package git

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	shaPattern = regexp.MustCompile(`^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$`)
	idPattern  = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$`)
)

const (
	defaultCommandTimeout = 10 * time.Minute
	maxCommandOutput      = 16 << 20
	maxErrorOutput        = 4 << 10
	maxReadFileBytes      = 16 << 20
)

type Manager struct {
	root          string
	mirrorRoot    string
	workspaceRoot string
	gitlabURL     *url.URL
	token         string
	timeout       time.Duration

	locksMu sync.Mutex
	locks   map[int64]*sync.Mutex
}

type Workspace struct {
	ProjectID int64
	JobID     string
	Path      string
	HeadSHA   string
}

func NewManager(root, gitlabBaseURL, token string) (*Manager, error) {
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("Git storage root is required")
	}
	baseURL, err := url.Parse(gitlabBaseURL)
	if err != nil || baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" ||
		baseURL.Fragment != "" || (baseURL.Scheme != "https" && baseURL.Scheme != "http") {
		return nil, fmt.Errorf("invalid GitLab base URL %q", gitlabBaseURL)
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve Git storage root: %w", err)
	}
	manager := &Manager{
		root:          absoluteRoot,
		mirrorRoot:    filepath.Join(absoluteRoot, "mirrors"),
		workspaceRoot: filepath.Join(absoluteRoot, "workspaces"),
		gitlabURL:     baseURL,
		token:         token,
		timeout:       defaultCommandTimeout,
		locks:         make(map[int64]*sync.Mutex),
	}
	for _, directory := range []string{manager.mirrorRoot, manager.workspaceRoot} {
		if err := os.MkdirAll(directory, 0o750); err != nil {
			return nil, fmt.Errorf("create Git storage directory: %w", err)
		}
	}
	return manager, nil
}

func (m *Manager) PrepareWorkspace(
	ctx context.Context,
	projectID int64,
	jobID string,
	repositoryURL string,
	expectedSHA string,
) (Workspace, error) {
	if projectID <= 0 {
		return Workspace{}, errors.New("project ID must be positive")
	}
	if !idPattern.MatchString(jobID) {
		return Workspace{}, errors.New("job ID contains invalid path characters")
	}
	if !shaPattern.MatchString(expectedSHA) {
		return Workspace{}, errors.New("expected commit SHA must be a full 40- or 64-character hexadecimal SHA")
	}
	canonicalURL, err := m.validateRepositoryURL(repositoryURL)
	if err != nil {
		return Workspace{}, err
	}

	projectLock := m.projectLock(projectID)
	projectLock.Lock()
	defer projectLock.Unlock()

	mirror := filepath.Join(m.mirrorRoot, fmt.Sprintf("%d.git", projectID))
	if err := m.updateMirror(ctx, mirror, canonicalURL); err != nil {
		return Workspace{}, err
	}
	if _, _, err := m.run(ctx, mirror, maxErrorOutput, "--git-dir", mirror, "cat-file", "-e", expectedSHA+"^{commit}"); err != nil {
		if fetchErr := m.runWithRetry(ctx, mirror, "--git-dir", mirror, "fetch", "--no-tags", "origin", expectedSHA); fetchErr != nil {
			return Workspace{}, fmt.Errorf("fetch expected commit %s: %w", expectedSHA, fetchErr)
		}
		if _, _, verifyErr := m.run(ctx, mirror, maxErrorOutput, "--git-dir", mirror,
			"cat-file", "-e", expectedSHA+"^{commit}"); verifyErr != nil {
			return Workspace{}, fmt.Errorf("expected commit %s is unavailable in project mirror", expectedSHA)
		}
	}

	projectWorkspaceRoot := filepath.Join(m.workspaceRoot, fmt.Sprintf("%d", projectID))
	if err := os.MkdirAll(projectWorkspaceRoot, 0o750); err != nil {
		return Workspace{}, fmt.Errorf("create project workspace directory: %w", err)
	}
	projectInfo, err := os.Lstat(projectWorkspaceRoot)
	if err != nil || !projectInfo.IsDir() || projectInfo.Mode()&os.ModeSymlink != 0 {
		return Workspace{}, errors.New("project workspace path is not a regular directory")
	}
	workspacePath := filepath.Join(projectWorkspaceRoot, jobID)
	if _, err := os.Lstat(workspacePath); err == nil {
		return Workspace{}, fmt.Errorf("workspace %q already exists", jobID)
	} else if !errors.Is(err, os.ErrNotExist) {
		return Workspace{}, fmt.Errorf("inspect workspace path: %w", err)
	}
	if _, _, err := m.run(ctx, mirror, maxErrorOutput, "--git-dir", mirror,
		"worktree", "add", "--detach", workspacePath, expectedSHA); err != nil {
		return Workspace{}, fmt.Errorf("create workspace for job %s: %w", jobID, err)
	}

	actualSHA, _, err := m.run(ctx, workspacePath, maxErrorOutput, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return Workspace{}, fmt.Errorf("verify workspace HEAD: %w", err)
	}
	if got := strings.TrimSpace(string(actualSHA)); !strings.EqualFold(got, expectedSHA) {
		_ = m.removeWorktree(ctx, mirror, workspacePath)
		return Workspace{}, fmt.Errorf("workspace HEAD mismatch: got %s, expected %s", got, expectedSHA)
	}

	return Workspace{ProjectID: projectID, JobID: jobID, Path: workspacePath, HeadSHA: expectedSHA}, nil
}

func (m *Manager) CleanupWorkspace(ctx context.Context, workspace Workspace) error {
	if workspace.ProjectID <= 0 || !idPattern.MatchString(workspace.JobID) {
		return errors.New("invalid workspace identity")
	}
	expectedPath := filepath.Join(m.workspaceRoot, fmt.Sprintf("%d", workspace.ProjectID), workspace.JobID)
	if filepath.Clean(workspace.Path) != expectedPath {
		return errors.New("workspace path does not match its managed location")
	}

	lock := m.projectLock(workspace.ProjectID)
	lock.Lock()
	defer lock.Unlock()

	mirror := filepath.Join(m.mirrorRoot, fmt.Sprintf("%d.git", workspace.ProjectID))
	return m.removeWorktree(ctx, mirror, expectedPath)
}

func (m *Manager) updateMirror(ctx context.Context, mirror, repositoryURL string) error {
	info, err := os.Lstat(mirror)
	if err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("project mirror path is not a regular directory")
		}
		configuredURL, _, err := m.run(ctx, mirror, maxErrorOutput, "--git-dir", mirror,
			"config", "--get", "remote.origin.url")
		if err != nil {
			return fmt.Errorf("read project mirror origin: %w", err)
		}
		normalized, err := m.validateRepositoryURL(strings.TrimSpace(string(configuredURL)))
		if err != nil || normalized != repositoryURL {
			return errors.New("project mirror origin does not match the authorized GitLab repository")
		}
		if err := m.runWithRetry(ctx, mirror, "--git-dir", mirror, "remote", "update", "--prune"); err != nil {
			return fmt.Errorf("update project mirror: %w", err)
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect project mirror: %w", err)
	}

	temporaryRoot, err := os.MkdirTemp(m.mirrorRoot, ".clone-*")
	if err != nil {
		return fmt.Errorf("create temporary mirror directory: %w", err)
	}
	defer os.RemoveAll(temporaryRoot)
	temporaryMirror := filepath.Join(temporaryRoot, "repository.git")
	if err := m.cloneMirrorWithRetry(ctx, repositoryURL, temporaryMirror); err != nil {
		return fmt.Errorf("clone project mirror: %w", err)
	}
	if err := os.Rename(temporaryMirror, mirror); err != nil {
		return fmt.Errorf("install project mirror: %w", err)
	}
	return nil
}

func (m *Manager) removeWorktree(ctx context.Context, mirror, workspacePath string) error {
	if _, err := os.Lstat(workspacePath); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return fmt.Errorf("inspect workspace before cleanup: %w", err)
	}
	if _, _, err := m.run(ctx, mirror, maxErrorOutput, "--git-dir", mirror,
		"worktree", "remove", "--force", workspacePath); err != nil {
		return fmt.Errorf("remove workspace: %w", err)
	}
	if _, _, err := m.run(ctx, mirror, maxErrorOutput, "--git-dir", mirror, "worktree", "prune"); err != nil {
		return fmt.Errorf("prune worktree metadata: %w", err)
	}
	return nil
}

func (m *Manager) validateRepositoryURL(raw string) (string, error) {
	repository, err := url.Parse(raw)
	if err != nil || repository.Host == "" || repository.User != nil ||
		repository.RawQuery != "" || repository.Fragment != "" {
		return "", errors.New("repository URL must not contain credentials, query parameters, or a fragment")
	}
	if repository.Scheme != m.gitlabURL.Scheme || !strings.EqualFold(repository.Host, m.gitlabURL.Host) {
		return "", errors.New("repository URL must use the configured GitLab scheme and host")
	}
	if repository.Path == "" || strings.Contains(repository.Path, "\\") ||
		repository.ForceQuery || repository.RawFragment != "" {
		return "", errors.New("repository URL contains an invalid path")
	}
	for _, segment := range strings.Split(repository.Path, "/") {
		if segment == "." || segment == ".." {
			return "", errors.New("repository URL contains an invalid path")
		}
	}
	repository.Path = strings.TrimSuffix(repository.Path, "/")
	repository.RawPath = ""
	return repository.String(), nil
}

func (m *Manager) runWithRetry(ctx context.Context, directory string, args ...string) error {
	const maxAttempts = 3
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if _, _, err := m.run(ctx, directory, maxCommandOutput, args...); err == nil {
			return nil
		} else {
			lastErr = err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if attempt == maxAttempts-1 {
			break
		}
		if err := waitBeforeRetry(ctx, attempt); err != nil {
			return err
		}
	}
	return lastErr
}

func (m *Manager) cloneMirrorWithRetry(ctx context.Context, repositoryURL, destination string) error {
	const maxAttempts = 3
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if err := os.RemoveAll(destination); err != nil {
			return fmt.Errorf("clean failed mirror clone: %w", err)
		}
		if _, _, err := m.run(ctx, m.root, maxCommandOutput, "clone", "--mirror", "--quiet", repositoryURL, destination); err == nil {
			return nil
		} else {
			lastErr = err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if attempt < maxAttempts-1 {
			if err := waitBeforeRetry(ctx, attempt); err != nil {
				return err
			}
		}
	}
	return lastErr
}

func waitBeforeRetry(ctx context.Context, attempt int) error {
	delay := time.Duration(1<<attempt) * 200 * time.Millisecond
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (m *Manager) projectLock(projectID int64) *sync.Mutex {
	m.locksMu.Lock()
	defer m.locksMu.Unlock()
	lock := m.locks[projectID]
	if lock == nil {
		lock = &sync.Mutex{}
		m.locks[projectID] = lock
	}
	return lock
}

func (m *Manager) run(ctx context.Context, directory string, outputLimit int, args ...string) ([]byte, bool, error) {
	commandCtx, cancel := context.WithTimeout(ctx, m.timeout)
	defer cancel()
	cmd := exec.CommandContext(commandCtx, "git", args...)
	cmd.Dir = directory
	cmd.Env = m.gitEnvironment()
	stdout := &limitedBuffer{limit: outputLimit}
	stderr := &limitedBuffer{limit: maxErrorOutput}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return stdout.Bytes(), stdout.truncated, fmt.Errorf("git command failed: %s", message)
	}
	return stdout.Bytes(), stdout.truncated, nil
}

func (m *Manager) gitEnvironment() []string {
	env := make([]string, 0, len(os.Environ())+8)
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "GIT_CONFIG_") || name == "GIT_DIR" || name == "GIT_WORK_TREE" ||
			name == "GIT_INDEX_FILE" || strings.HasPrefix(name, "GIT_TRACE") ||
			name == "GIT_CURL_VERBOSE" || name == "GIT_TERMINAL_PROMPT" {
			continue
		}
		env = append(env, entry)
	}
	env = append(env, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0")
	if m.token != "" {
		credentials := base64.StdEncoding.EncodeToString([]byte("oauth2:" + m.token))
		env = append(env,
			"GIT_CONFIG_COUNT=3",
			"GIT_CONFIG_KEY_0=core.hooksPath",
			"GIT_CONFIG_VALUE_0=/dev/null",
			"GIT_CONFIG_KEY_1=credential.helper",
			"GIT_CONFIG_VALUE_1=",
			"GIT_CONFIG_KEY_2=http."+m.gitlabURL.Scheme+"://"+m.gitlabURL.Host+"/.extraHeader",
			"GIT_CONFIG_VALUE_2=Authorization: Basic "+credentials,
		)
	} else {
		env = append(env,
			"GIT_CONFIG_COUNT=2",
			"GIT_CONFIG_KEY_0=core.hooksPath",
			"GIT_CONFIG_VALUE_0=/dev/null",
			"GIT_CONFIG_KEY_1=credential.helper",
			"GIT_CONFIG_VALUE_1=",
		)
	}
	return env
}

type limitedBuffer struct {
	data      []byte
	limit     int
	truncated bool
}

func (b *limitedBuffer) Write(value []byte) (int, error) {
	remaining := b.limit - len(b.data)
	if remaining <= 0 {
		b.truncated = true
		return len(value), nil
	}
	if len(value) > remaining {
		b.data = append(b.data, value[:remaining]...)
		b.truncated = true
		return len(value), nil
	}
	b.data = append(b.data, value...)
	return len(value), nil
}

func (b *limitedBuffer) Bytes() []byte {
	return b.data
}

func (b *limitedBuffer) String() string {
	return string(b.data)
}
