package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server  ServerConfig  `yaml:"server"`
	GitLab  GitLabConfig  `yaml:"gitlab"`
	Storage StorageConfig `yaml:"storage"`
	Agent   AgentConfig   `yaml:"agent"`
	Review  ReviewConfig  `yaml:"review"`
	Worker  WorkerConfig  `yaml:"worker"`
	Fix     FixConfig     `yaml:"fix"`
}

type ServerConfig struct {
	Listen          string   `yaml:"listen"`
	ReadTimeout     Duration `yaml:"read_timeout"`
	ShutdownTimeout Duration `yaml:"shutdown_timeout"`
}

type Duration time.Duration

func (d *Duration) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind != yaml.ScalarNode {
		return errors.New("duration must be a scalar")
	}
	value, err := time.ParseDuration(node.Value)
	if err != nil {
		return fmt.Errorf("invalid duration %q: %w", node.Value, err)
	}
	*d = Duration(value)
	return nil
}

type GitLabConfig struct {
	BaseURL           string  `yaml:"base_url"`
	ReadToken         string  `yaml:"-"`
	WriteToken        string  `yaml:"-"`
	WebhookSecret     string  `yaml:"-"`
	AllowedProjectIDs []int64 `yaml:"allowed_project_ids"`
	AllowedUserIDs    []int64 `yaml:"allowed_user_ids"`
	BotUsername       string  `yaml:"bot_username"`
}

type StorageConfig struct {
	Root     string `yaml:"root"`
	Database string `yaml:"database"`
}

type AgentConfig struct {
	Enabled          bool     `yaml:"enabled"`
	BaseURL          string   `yaml:"base_url"`
	Model            string   `yaml:"model"`
	APIKey           string   `yaml:"-"`
	RequestTimeout   Duration `yaml:"request_timeout"`
	MaxOutputTokens  int      `yaml:"max_output_tokens"`
	DailyTokenBudget int64    `yaml:"daily_token_budget"`
}

type ReviewConfig struct {
	MaxFiles        int `yaml:"max_files"`
	MaxFindings     int `yaml:"max_findings"`
	MaxContextBytes int `yaml:"max_context_bytes"`
}

type WorkerConfig struct {
	PollInterval Duration `yaml:"poll_interval"`
	JobTimeout   Duration `yaml:"job_timeout"`
}

type FixConfig struct {
	Enabled        bool    `yaml:"enabled"`
	AllowedUserIDs []int64 `yaml:"allowed_user_ids"`
	MaxPatchBytes  int     `yaml:"max_patch_bytes"`
}

func Load(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read config %q: %w", path, err)
	}
	cfg := Config{
		Server: ServerConfig{
			Listen:          "0.0.0.0:8080",
			ReadTimeout:     Duration(5 * time.Second),
			ShutdownTimeout: Duration(30 * time.Second),
		},
		Agent: AgentConfig{RequestTimeout: Duration(120 * time.Second), MaxOutputTokens: 4096},
		Review: ReviewConfig{
			MaxFiles:        100,
			MaxFindings:     30,
			MaxContextBytes: 2 << 20,
		},
		Worker: WorkerConfig{
			PollInterval: Duration(2 * time.Second),
			JobTimeout:   Duration(30 * time.Minute),
		},
		Fix: FixConfig{MaxPatchBytes: 128 << 10},
	}
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("parse config %q: %w", path, err)
	}

	setStringFromEnv(&cfg.GitLab.ReadToken, "CORVEX_GITLAB_READ_TOKEN")
	setStringFromEnv(&cfg.GitLab.WriteToken, "CORVEX_GITLAB_TOKEN")
	setStringFromEnv(&cfg.GitLab.WebhookSecret, "CORVEX_WEBHOOK_SECRET")
	setStringFromEnv(&cfg.Agent.APIKey, "CORVEX_MODEL_API_KEY")
	if v, ok := os.LookupEnv("CORVEX_MODEL_BASE_URL"); ok {
		cfg.Agent.BaseURL = v
	}
	if v, ok := os.LookupEnv("CORVEX_MODEL_NAME"); ok {
		cfg.Agent.Model = v
	}
	if v, ok := os.LookupEnv("CORVEX_GITLAB_BASE_URL"); ok {
		cfg.GitLab.BaseURL = v
	}
	if v, ok := os.LookupEnv("CORVEX_DATABASE"); ok {
		cfg.Storage.Database = v
	}
	if v, ok := os.LookupEnv("CORVEX_STORAGE_ROOT"); ok {
		cfg.Storage.Root = v
	}
	if v, ok := os.LookupEnv("CORVEX_LISTEN"); ok {
		cfg.Server.Listen = v
	}

	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	if err := os.MkdirAll(filepath.Dir(cfg.Storage.Database), 0o750); err != nil {
		return Config{}, fmt.Errorf("create database directory: %w", err)
	}
	for _, directory := range []string{
		filepath.Join(cfg.Storage.Root, "mirrors"),
		filepath.Join(cfg.Storage.Root, "workspaces"),
	} {
		if err := os.MkdirAll(directory, 0o750); err != nil {
			return Config{}, fmt.Errorf("create storage directory %q: %w", directory, err)
		}
	}
	return cfg, nil
}

func (c Config) Validate() error {
	var problems []string
	if strings.TrimSpace(c.Server.Listen) == "" {
		problems = append(problems, "server.listen is required")
	}
	if c.Server.ReadTimeout <= 0 || c.Server.ShutdownTimeout <= 0 {
		problems = append(problems, "server timeouts must be positive")
	}
	u, err := url.ParseRequestURI(c.GitLab.BaseURL)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		problems = append(problems, "gitlab.base_url must be a valid HTTP(S) URL")
	}
	if strings.TrimSpace(c.GitLab.ReadToken) == "" {
		problems = append(problems, "CORVEX_GITLAB_READ_TOKEN is required")
	}
	if strings.TrimSpace(c.GitLab.WriteToken) == "" {
		problems = append(problems, "CORVEX_GITLAB_TOKEN is required")
	}
	if strings.TrimSpace(c.GitLab.WebhookSecret) == "" {
		problems = append(problems, "CORVEX_WEBHOOK_SECRET is required")
	}
	if len(c.GitLab.AllowedProjectIDs) == 0 {
		problems = append(problems, "gitlab.allowed_project_ids must not be empty")
	}
	if len(c.GitLab.AllowedUserIDs) == 0 {
		problems = append(problems, "gitlab.allowed_user_ids must not be empty")
	}
	if strings.TrimSpace(c.Storage.Root) == "" {
		problems = append(problems, "storage.root is required")
	}
	if strings.TrimSpace(c.Storage.Database) == "" {
		problems = append(problems, "storage.database is required")
	}
	if c.Review.MaxFiles <= 0 || c.Review.MaxFiles > 1000 {
		problems = append(problems, "review.max_files must be between 1 and 1000")
	}
	if c.Review.MaxFindings <= 0 || c.Review.MaxFindings > 100 {
		problems = append(problems, "review.max_findings must be between 1 and 100")
	}
	if c.Review.MaxContextBytes <= 0 || c.Review.MaxContextBytes > 8<<20 {
		problems = append(problems, "review.max_context_bytes must be between 1 byte and 8 MiB")
	}
	if c.Worker.PollInterval <= 0 || c.Worker.JobTimeout <= 0 {
		problems = append(problems, "worker poll interval and job timeout must be positive")
	}
	if c.Fix.Enabled && len(c.Fix.AllowedUserIDs) == 0 {
		problems = append(problems, "fix.allowed_user_ids must not be empty when fix.enabled is true")
	}
	if c.Fix.Enabled && !c.Agent.Enabled {
		problems = append(problems, "agent.enabled must be true when fix.enabled is true")
	}
	if c.Fix.MaxPatchBytes <= 0 || c.Fix.MaxPatchBytes > 256<<10 {
		problems = append(problems, "fix.max_patch_bytes must be between 1 byte and 256 KiB")
	}
	if c.Agent.Enabled {
		modelURL, err := url.ParseRequestURI(c.Agent.BaseURL)
		if err != nil || modelURL.Host == "" || modelURL.User != nil ||
			modelURL.RawQuery != "" || modelURL.Fragment != "" ||
			(modelURL.Scheme != "https" && modelURL.Scheme != "http") {
			problems = append(problems, "agent.base_url must be a valid HTTP(S) URL without credentials")
		}
		if strings.TrimSpace(c.Agent.Model) == "" {
			problems = append(problems, "agent.model is required when the agent is enabled")
		}
		if strings.TrimSpace(c.Agent.APIKey) == "" {
			problems = append(problems, "CORVEX_MODEL_API_KEY is required when the agent is enabled")
		}
		if c.Agent.RequestTimeout <= 0 {
			problems = append(problems, "agent.request_timeout must be positive")
		}
		if c.Agent.MaxOutputTokens <= 0 || c.Agent.MaxOutputTokens > 8192 {
			problems = append(problems, "agent.max_output_tokens must be between 1 and 8192")
		}
		if c.Agent.DailyTokenBudget < 0 || c.Agent.DailyTokenBudget > 1_000_000_000 {
			problems = append(problems, "agent.daily_token_budget must be between 0 and 1000000000")
		}
	}
	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}
	return nil
}

func setStringFromEnv(dst *string, key string) {
	if v, ok := os.LookupEnv(key); ok {
		*dst = v
	}
}
