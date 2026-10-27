package gitlab

import (
	"errors"
	"slices"
	"testing"
)

func TestParseCommand(t *testing.T) {
	tests := []struct {
		note    string
		name    string
		args    []string
		wantErr bool
	}{
		{note: "  @Corvex   REVIEW \n", name: "review"},
		{note: "@corvex status", name: "status"},
		{note: "@corvex fix bug-123", name: "fix", args: []string{"bug-123"}},
		{note: "hello @corvex review", wantErr: true},
		{note: "@corvex unknown", wantErr: true},
		{note: "@corvex", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.note, func(t *testing.T) {
			got, err := ParseCommand(tt.note)
			if tt.wantErr {
				if err == nil {
					t.Fatal("ParseCommand() error = nil, want error")
				}
				if tt.note == "hello @corvex review" && !errors.Is(err, ErrNotCommand) {
					t.Fatalf("ParseCommand() error = %v, want ErrNotCommand", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseCommand() error = %v", err)
			}
			if got.Name != tt.name || !slices.Equal(got.Args, tt.args) {
				t.Fatalf("ParseCommand() = %#v, want name %q args %#v", got, tt.name, tt.args)
			}
		})
	}
}
