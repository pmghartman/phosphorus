# the binary and its checks, the same as CI's
BIN ?= phosphorus

.PHONY: all web build check test licenses clean

all: build

# the client's bundle, from pinned npm tarballs, into internal/web/dist
web:
	go generate ./internal/web

build: web
	CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o $(BIN) ./cmd/phosphorus

check: web
	@test -z "$$(gofmt -l cmd internal)" || { gofmt -l cmd internal; exit 1; }
	go vet ./...
	GOOS=darwin go vet ./...
	GOOS=windows go vet ./...

test: web
	go test ./...

# THIRD_PARTY_LICENSES.txt regenerated, CI failing a release while it's stale
licenses: web
	go run ./cmd/licenses

clean:
	rm -rf $(BIN) web/.vendor
	find internal/web/dist -mindepth 1 ! -name README -delete
