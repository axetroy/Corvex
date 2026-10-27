package gitlab

import (
	"errors"
	"fmt"
	"strings"
)

type Command struct {
	Name string
	Args []string
}

var ErrNotCommand = errors.New("not a Corvex command")

func ParseCommand(note string) (Command, error) {
	fields := strings.Fields(strings.TrimSpace(note))
	if len(fields) == 0 || !strings.EqualFold(fields[0], "@corvex") {
		return Command{}, ErrNotCommand
	}
	if len(fields) < 2 {
		return Command{}, errors.New("missing command; use review, status, or cancel")
	}
	command := Command{Name: strings.ToLower(fields[1]), Args: fields[2:]}
	switch command.Name {
	case "review", "status", "cancel", "fix", "explain":
		return command, nil
	default:
		return Command{}, fmt.Errorf("unknown command %q; supported commands are review, status, and cancel", fields[1])
	}
}
