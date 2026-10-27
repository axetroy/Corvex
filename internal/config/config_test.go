package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadYAMLAndEnvironmentSecrets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	data := []byte(`server:
  listen: "127.0.0.1:8080"
  read_timeout: 7s
  shutdown_timeout: 20s
gitlab:
  base_url: "https://gitlab.example.test"
  allowed_project_ids: [4]
  allowed_user_ids: [8]
storage:
  root: "` + filepath.Join(t.TempDir(), "corvex") + `"
  database: "` + filepath.Join(t.TempDir(), "state", "corvex.db") + `"
agent:
  enabled: true
  base_url: "https://api.example.test/v1"
  model: "review-model"
  request_timeout: 45s
review:
  max_files: 12
  max_findings: 7
  max_context_bytes: 4096
`)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CORVEX_GITLAB_TOKEN", "token")
	t.Setenv("CORVEX_GITLAB_READ_TOKEN", "read-token")
	t.Setenv("CORVEX_WEBHOOK_SECRET", "secret")
	t.Setenv("CORVEX_MODEL_API_KEY", "model-secret")

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.ReadTimeout != Duration(7*time.Second) || cfg.GitLab.WriteToken != "token" ||
		cfg.GitLab.ReadToken != "read-token" {
		t.Fatalf("unexpected loaded config: %#v", cfg)
	}
	if !cfg.Agent.Enabled || cfg.Agent.APIKey != "model-secret" ||
		cfg.Agent.RequestTimeout != Duration(45*time.Second) || cfg.Review.MaxFindings != 7 ||
		cfg.Review.MaxContextBytes != 4096 {
		t.Fatalf("unexpected model configuration: %#v", cfg)
	}
	for _, dir := range []string{"mirrors", "workspaces"} {
		if _, err := os.Stat(filepath.Join(cfg.Storage.Root, dir)); err != nil {
			t.Fatalf("storage directory %q was not created: %v", dir, err)
		}
	}
}
