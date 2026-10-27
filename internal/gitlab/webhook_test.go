package gitlab

import (
	"strings"
	"testing"
)

func TestValidateWebhookToken(t *testing.T) {
	if !ValidateWebhookToken("secret", "secret") {
		t.Fatal("matching token was rejected")
	}
	for _, token := range []string{"", "wrong", "secret-longer"} {
		if ValidateWebhookToken("secret", token) {
			t.Errorf("ValidateWebhookToken(%q) = true, want false", token)
		}
	}
}

func TestDecodeNoteEvent(t *testing.T) {
	valid := `{"object_kind":"note","user":{"id":7,"username":"dev"},"project":{"id":11},"object_attributes":{"id":99,"note":"@corvex review","noteable_type":"MergeRequest"},"merge_request":{"iid":3,"last_commit":{"id":"abc"}}}`
	event, err := DecodeNoteEvent(strings.NewReader(valid))
	if err != nil {
		t.Fatalf("DecodeNoteEvent() error = %v", err)
	}
	if event.Project.ID != 11 || event.MergeRequest.IID != 3 || event.User.ID != 7 {
		t.Fatalf("decoded event has unexpected identifiers: %#v", event)
	}
	if _, err := DecodeNoteEvent(strings.NewReader(`{"object_kind":"push"}`)); err == nil {
		t.Fatal("unsupported event was accepted")
	}
}
