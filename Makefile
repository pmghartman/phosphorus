# the binaries and their checks, the same as CI's; bun does the work
.PHONY: all web build check test licenses clean

all: build

# the client's bundle, from the workspace's pinned packages, into packages/webstatic/dist
web:
	bun install --frozen-lockfile
	bun run web

# the host (and, off Linux, the tray) compiled for this machine, into dist/
build: web
	bun scripts/build.ts $(shell bun -e 'console.log(process.platform === "win32" ? "windows" : process.platform, process.arch)' | sed 's/ /-/') dist

check: web
	bun run check
	bun scripts/licenses.ts --check

test: web
	bun test

# THIRD_PARTY_NOTICES.txt and the SBOM, into dist/; CI ships them in each installer
licenses: web
	bun scripts/licenses.ts dist

clean:
	rm -rf dist packages/webstatic/dist packages/webstatic/src/manifest.ts
