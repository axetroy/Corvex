package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/axetroy/corvex/internal/agent"
	"github.com/axetroy/corvex/internal/app"
	"github.com/axetroy/corvex/internal/config"
	fixengine "github.com/axetroy/corvex/internal/fix"
	"github.com/axetroy/corvex/internal/git"
	"github.com/axetroy/corvex/internal/gitlab"
	"github.com/axetroy/corvex/internal/jobs"
	"github.com/axetroy/corvex/internal/review"
)

func main() {
	if err := run(); err != nil {
		slog.Error("corvex stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) > 1 && os.Args[1] == "backup" {
		return runBackup(os.Args[2:])
	}
	flags := flag.NewFlagSet("corvex", flag.ContinueOnError)
	configPath := flags.String("config", "configs/config.yaml", "path to YAML configuration")
	if err := flags.Parse(os.Args[1:]); err != nil {
		return err
	}
	if flags.NArg() > 1 {
		return errors.New("usage: corvex [--config path] [server|worker]")
	}
	mode := "server"
	if flags.NArg() == 1 {
		mode = flags.Arg(0)
		if mode != "server" && mode != "worker" {
			return fmt.Errorf("unsupported mode %q; use server or worker", mode)
		}
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		return err
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	store, err := jobs.Open(cfg.Storage.Database)
	if err != nil {
		return fmt.Errorf("open task store: %w", err)
	}
	defer store.Close()

	gitlabClient, err := gitlab.NewClientWithTokens(cfg.GitLab.BaseURL, cfg.GitLab.ReadToken, cfg.GitLab.WriteToken)
	if err != nil {
		return fmt.Errorf("create GitLab client: %w", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if mode == "server" {
		return app.NewServer(cfg, store, gitlabClient, logger).Run(ctx)
	}
	if !cfg.Agent.Enabled {
		return errors.New("worker mode requires agent.enabled=true")
	}
	gitManager, err := git.NewManager(cfg.Storage.Root, cfg.GitLab.BaseURL, cfg.GitLab.ReadToken)
	if err != nil {
		return fmt.Errorf("create Git manager: %w", err)
	}
	modelClient, err := agent.NewClientWithTokenBudget(cfg.Agent.BaseURL, cfg.Agent.APIKey, cfg.Agent.Model,
		time.Duration(cfg.Agent.RequestTimeout), cfg.Agent.MaxOutputTokens, store, cfg.Agent.DailyTokenBudget)
	if err != nil {
		return fmt.Errorf("create model client: %w", err)
	}
	reviewWorkflow, err := review.NewWorkflow(modelClient, cfg.Review.MaxFiles, cfg.Review.MaxFindings,
		cfg.Review.MaxContextBytes)
	if err != nil {
		return fmt.Errorf("create review workflow: %w", err)
	}
	var fixWorkflow *fixengine.Workflow
	if cfg.Fix.Enabled {
		fixWorkflow, err = fixengine.NewWorkflow(modelClient, cfg.Review.MaxContextBytes, cfg.Fix.MaxPatchBytes)
		if err != nil {
			return fmt.Errorf("create fix workflow: %w", err)
		}
	}
	worker, err := app.NewWorker(cfg, store, gitlabClient, gitManager, reviewWorkflow, fixWorkflow, logger)
	if err != nil {
		return fmt.Errorf("create worker: %w", err)
	}
	return worker.Run(ctx)
}

func runBackup(args []string) error {
	flags := flag.NewFlagSet("corvex backup", flag.ContinueOnError)
	databasePath := flags.String("database", "", "path to the Corvex SQLite database")
	outputPath := flags.String("output", "", "path for the new SQLite backup file")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *databasePath == "" || *outputPath == "" {
		return errors.New("usage: corvex backup --database <path> --output <new-path>")
	}
	store, err := jobs.Open(*databasePath)
	if err != nil {
		return fmt.Errorf("open task store: %w", err)
	}
	defer store.Close()
	if err := store.Backup(context.Background(), *outputPath); err != nil {
		return err
	}
	slog.Info("SQLite backup created", "output", *outputPath)
	return nil
}
