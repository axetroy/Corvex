package gitlab

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const maxWebhookBody = 1 << 20
const maxGitLabResponseBody = 20 << 20
const maxGitLabDiffBytes = 16 << 20

type NoteEvent struct {
	ObjectKind string `json:"object_kind"`
	User       struct {
		ID       int64  `json:"id"`
		Username string `json:"username"`
	} `json:"user"`
	Project struct {
		ID int64 `json:"id"`
	} `json:"project"`
	ObjectAttributes struct {
		ID           int64  `json:"id"`
		Note         string `json:"note"`
		NoteableType string `json:"noteable_type"`
		System       bool   `json:"system"`
	} `json:"object_attributes"`
	MergeRequest struct {
		IID        int64 `json:"iid"`
		LastCommit struct {
			ID string `json:"id"`
		} `json:"last_commit"`
	} `json:"merge_request"`
}

type Client struct {
	baseURL    string
	readToken  string
	writeToken string
	httpClient *http.Client
}

type MergeRequest struct {
	IID          int64  `json:"iid"`
	State        string `json:"state"`
	Title        string `json:"title"`
	Description  string `json:"description"`
	SourceBranch string `json:"source_branch"`
	TargetBranch string `json:"target_branch"`
	SHA          string `json:"sha"`
	DiffRefs     struct {
		BaseSHA  string `json:"base_sha"`
		StartSHA string `json:"start_sha"`
		HeadSHA  string `json:"head_sha"`
	} `json:"diff_refs"`
}

type Project struct {
	ID            int64  `json:"id"`
	HTTPURLToRepo string `json:"http_url_to_repo"`
}

type DiscussionPosition struct {
	BaseSHA  string
	StartSHA string
	HeadSHA  string
	OldPath  string
	NewPath  string
	NewLine  int
}

func (mr MergeRequest) HeadSHA() string {
	if mr.DiffRefs.HeadSHA != "" {
		return mr.DiffRefs.HeadSHA
	}
	return mr.SHA
}

func isFullSHA(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for _, character := range value {
		if !((character >= '0' && character <= '9') ||
			(character >= 'a' && character <= 'f') ||
			(character >= 'A' && character <= 'F')) {
			return false
		}
	}
	return true
}

func validDiscussionPath(value string) bool {
	if value == "" || strings.HasPrefix(value, "/") || strings.Contains(value, "\\") {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

type MergeRequestDiff struct {
	OldPath     string `json:"old_path"`
	NewPath     string `json:"new_path"`
	Diff        string `json:"diff"`
	NewFile     bool   `json:"new_file"`
	RenamedFile bool   `json:"renamed_file"`
	DeletedFile bool   `json:"deleted_file"`
	TooLarge    bool   `json:"too_large"`
	Collapsed   bool   `json:"collapsed"`
}

func NewClient(baseURL, token string) (*Client, error) {
	return NewClientWithTokens(baseURL, token, token)
}

func NewClientWithTokens(baseURL, readToken, writeToken string) (*Client, error) {
	parsed, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" ||
		parsed.Fragment != "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return nil, fmt.Errorf("invalid GitLab base URL %q", baseURL)
	}
	if readToken == "" || writeToken == "" {
		return nil, errors.New("GitLab read and write API tokens are required")
	}
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		readToken:  readToken,
		writeToken: writeToken,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}, nil
}

func ValidateWebhookToken(expected, got string) bool {
	if expected == "" || got == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(got)) == 1
}

func DecodeNoteEvent(body io.Reader) (NoteEvent, error) {
	var event NoteEvent
	payload, err := io.ReadAll(io.LimitReader(body, maxWebhookBody+1))
	if err != nil {
		return NoteEvent{}, fmt.Errorf("read GitLab note event: %w", err)
	}
	if len(payload) > maxWebhookBody {
		return NoteEvent{}, errors.New("GitLab webhook payload exceeds 1 MiB")
	}
	if err := json.Unmarshal(payload, &event); err != nil {
		return NoteEvent{}, fmt.Errorf("decode GitLab note event: %w", err)
	}
	if event.ObjectKind != "note" || event.ObjectAttributes.NoteableType != "MergeRequest" ||
		event.ObjectAttributes.ID <= 0 || event.Project.ID <= 0 || event.MergeRequest.IID <= 0 ||
		event.User.ID <= 0 {
		return NoteEvent{}, errors.New("incomplete or unsupported GitLab note event")
	}
	return event, nil
}

func (c *Client) PostNote(ctx context.Context, projectID, mrIID int64, body string) error {
	endpoint := c.baseURL + "/api/v4/projects/" + strconv.FormatInt(projectID, 10) +
		"/merge_requests/" + strconv.FormatInt(mrIID, 10) + "/notes"
	form := url.Values{"body": {body}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewBufferString(form.Encode()))
	if err != nil {
		return fmt.Errorf("create GitLab note request: %w", err)
	}
	req.Header.Set("PRIVATE-TOKEN", c.writeToken)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("post GitLab MR note: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		responseBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return fmt.Errorf("GitLab API returned %s: %s", resp.Status, strings.TrimSpace(string(responseBody)))
	}
	return nil
}

func (c *Client) PostDiscussion(
	ctx context.Context,
	projectID, mrIID int64,
	body string,
	position DiscussionPosition,
) error {
	if projectID <= 0 || mrIID <= 0 {
		return errors.New("project ID and MR IID must be positive")
	}
	if !isFullSHA(position.BaseSHA) || !isFullSHA(position.StartSHA) || !isFullSHA(position.HeadSHA) {
		return errors.New("discussion position requires full base, start, and head SHAs")
	}
	if !validDiscussionPath(position.OldPath) || !validDiscussionPath(position.NewPath) || position.NewLine <= 0 {
		return errors.New("discussion position has an invalid path or new line")
	}
	endpoint := c.baseURL + "/api/v4/projects/" + strconv.FormatInt(projectID, 10) +
		"/merge_requests/" + strconv.FormatInt(mrIID, 10) + "/discussions"
	form := url.Values{
		"body":                    {body},
		"position[position_type]": {"text"},
		"position[base_sha]":      {position.BaseSHA},
		"position[start_sha]":     {position.StartSHA},
		"position[head_sha]":      {position.HeadSHA},
		"position[old_path]":      {position.OldPath},
		"position[new_path]":      {position.NewPath},
		"position[new_line]":      {strconv.Itoa(position.NewLine)},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return fmt.Errorf("create GitLab discussion request: %w", err)
	}
	req.Header.Set("PRIVATE-TOKEN", c.writeToken)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("post GitLab MR discussion: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		responseBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return fmt.Errorf("GitLab API returned %s: %s", resp.Status, strings.TrimSpace(string(responseBody)))
	}
	return nil
}

func (c *Client) GetMergeRequest(ctx context.Context, projectID, mrIID int64) (MergeRequest, error) {
	var mergeRequest MergeRequest
	if projectID <= 0 || mrIID <= 0 {
		return mergeRequest, errors.New("project ID and MR IID must be positive")
	}
	endpoint := c.baseURL + "/api/v4/projects/" + strconv.FormatInt(projectID, 10) +
		"/merge_requests/" + strconv.FormatInt(mrIID, 10)
	if err := c.getJSON(ctx, endpoint, &mergeRequest); err != nil {
		return MergeRequest{}, fmt.Errorf("get GitLab merge request: %w", err)
	}
	if mergeRequest.IID != mrIID {
		return MergeRequest{}, errors.New("GitLab returned a merge request with a mismatched IID")
	}
	return mergeRequest, nil
}

func (c *Client) GetProject(ctx context.Context, projectID int64) (Project, error) {
	var project Project
	if projectID <= 0 {
		return project, errors.New("project ID must be positive")
	}
	endpoint := c.baseURL + "/api/v4/projects/" + strconv.FormatInt(projectID, 10)
	if err := c.getJSON(ctx, endpoint, &project); err != nil {
		return Project{}, fmt.Errorf("get GitLab project: %w", err)
	}
	if project.ID != projectID || project.HTTPURLToRepo == "" {
		return Project{}, errors.New("GitLab returned incomplete or mismatched project metadata")
	}
	return project, nil
}

func (c *Client) GetMergeRequestDiff(
	ctx context.Context,
	projectID, mrIID int64,
) ([]MergeRequestDiff, error) {
	if projectID <= 0 || mrIID <= 0 {
		return nil, errors.New("project ID and MR IID must be positive")
	}
	const (
		pageSize     = 100
		maxDiffPages = 20
		maxDiffFiles = 2000
	)
	var all []MergeRequestDiff
	totalBytes := 0
	for page := 1; page <= maxDiffPages; page++ {
		endpoint := c.baseURL + "/api/v4/projects/" + strconv.FormatInt(projectID, 10) +
			"/merge_requests/" + strconv.FormatInt(mrIID, 10) + "/diffs?per_page=" +
			strconv.Itoa(pageSize) + "&page=" + strconv.Itoa(page)
		var changes []MergeRequestDiff
		nextPage, err := c.getJSONPage(ctx, endpoint, &changes)
		if err != nil {
			return nil, fmt.Errorf("get GitLab merge request diff page %d: %w", page, err)
		}
		if len(all)+len(changes) > maxDiffFiles {
			return nil, fmt.Errorf("merge request diff exceeds the %d-file safety limit", maxDiffFiles)
		}
		for _, change := range changes {
			totalBytes += len(change.OldPath) + len(change.NewPath) + len(change.Diff)
			if totalBytes > maxGitLabDiffBytes {
				return nil, fmt.Errorf("merge request diff exceeds the %d-byte safety limit", maxGitLabDiffBytes)
			}
		}
		all = append(all, changes...)
		if nextPage == "" && len(changes) < pageSize {
			return all, nil
		}
		if nextPage == "" {
			continue
		}
		next, err := strconv.Atoi(nextPage)
		if err != nil || next != page+1 {
			return nil, fmt.Errorf("GitLab returned invalid pagination cursor %q", nextPage)
		}
	}
	return nil, fmt.Errorf("merge request diff exceeds the %d-page safety limit", maxDiffPages)
}

func (c *Client) getJSON(ctx context.Context, endpoint string, target any) error {
	_, err := c.getJSONPage(ctx, endpoint, target)
	return err
}

func (c *Client) getJSONPage(ctx context.Context, endpoint string, target any) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", fmt.Errorf("create GitLab API request: %w", err)
	}
	req.Header.Set("PRIVATE-TOKEN", c.readToken)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("send GitLab API request: %w", err)
	}
	defer resp.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(resp.Body, maxGitLabResponseBody+1))
	if err != nil {
		return "", fmt.Errorf("read GitLab API response: %w", err)
	}
	if len(responseBody) > maxGitLabResponseBody {
		return "", errors.New("GitLab API response exceeds 20 MiB")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("GitLab API returned %s: %s", resp.Status, strings.TrimSpace(string(responseBody)))
	}
	if err := json.Unmarshal(responseBody, target); err != nil {
		return "", fmt.Errorf("decode GitLab API response: %w", err)
	}
	return resp.Header.Get("X-Next-Page"), nil
}
