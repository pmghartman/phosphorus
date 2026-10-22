package server

import (
	"net/http/httptest"
	"testing"

	"github.com/pmghartman/phosphorus/internal/sysfs"
)

// the model gateway's page pass: never without a login, never for another site's page
func TestPageUserRefused(t *testing.T) {
	sysfs.Root = t.TempDir()
	r := httptest.NewRequest("POST", "http://mesh.test/api/model/v1/messages", nil)
	if pageUser(r) {
		t.Fatal("a pass with no login")
	}
	r.Header.Set("Origin", "https://elsewhere.test")
	if pageUser(r) {
		t.Fatal("a pass for another site's page")
	}
}
