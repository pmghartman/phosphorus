#!/bin/sh
# a workspace package's skeleton: packages/<group>/<name>/{package.json,src/}
for p in "$@"; do
  n=${p##*/}
  mkdir -p packages/$p/src
  [ -f packages/$p/package.json ] || printf '{ "name": "@phosphorus/%s", "private": true, "type": "module", "exports": { ".": "./src/index.ts" } }
' $n > packages/$p/package.json
done
