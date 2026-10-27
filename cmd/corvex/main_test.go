package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/axetroy/corvex/internal/jobs"
)

func TestRunBackupCreatesDatabaseCopy(t *testing.T) {
	directory := t.TempDir()
	databasePath := filepath.Join(directory, "state.db")
	store, err := jobs.Open(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	backupPath := filepath.Join(directory, "backup.db")
	if err := runBackup([]string{"--database", databasePath, "--output", backupPath}); err != nil {
		t.Fatalf("runBackup() error = %v", err)
	}
	if info, err := os.Stat(backupPath); err != nil {
		t.Fatal(err)
	} else if info.Size() == 0 {
		t.Fatal("backup command created an empty file")
	}
}
