#!/bin/sh
# node's old entry points, from launchers and ssh configs older than the
# binary, mapped onto it
case "${1:-}" in
  */cli/phosphorus.js) shift; exec phosphorus cli "$@" ;;
  */ssh-relay.js) shift; exec phosphorus ssh-relay "$@" ;;
esac
echo "no node in this image: phosphorus serve | model | elector | cli | ssh-relay" >&2
exit 127
