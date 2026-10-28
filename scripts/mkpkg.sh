#!/bin/sh
# a workspace package's skeleton: packages/<name>/{package.json,src/}
for n in "$@"; do
  mkdir -p packages/$n/src
  [ -f packages/$n/package.json ] || printf '{ "name": "@phosphorus/%s", "private": true, "type": "module", "exports": { ".": "./src/index.ts" } }\n' $n > packages/$n/package.json
done
