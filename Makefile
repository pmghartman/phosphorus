# the binary and its checks, the same as CI's
BIN ?= phosphorus
STATICCHECK = honnef.co/go/tools/cmd/staticcheck@v0.8.2

.PHONY: all web build check test dualrun mesh clean

all: build

# the client's bundle, from pinned npm tarballs, into internal/web/dist
web:
	go generate ./internal/web

build: web
	CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o $(BIN) ./cmd/phosphorus

check: web
	@test -z "$$(gofmt -l cmd internal test)" || { gofmt -l cmd internal test; exit 1; }
	go vet ./...
	go run $(STATICCHECK) ./...

test: web
	go test -race ./...

# the JS and Go frontends side by side, every endpoint diffed
dualrun: build
	test/dualrun/run.sh $(BIN)

# three hosts in network namespaces, JS and Go mixed, root only
mesh: build
	test/mesh/run.sh $(BIN)

clean:
	rm -rf $(BIN) web/.vendor
	find internal/web/dist -mindepth 1 ! -name README -delete
