#!/bin/sh
# oh-my-tau does not ship this installer.
#
# Upstream's `install.sh` installs upstream oh-my-pi: prebuilt binaries from its
# build service (build.stencil.so), the @oh-my-pi/pi-coding-agent npm package, or
# a can1357/oh-my-pi source checkout. Any of them would replace an oh-my-tau
# build, so this copy installs nothing and says how oh-my-tau installs and
# updates instead. It runs no download, package manager or git command.

cat >&2 <<'EOF'
This is oh-my-tau, a fork of oh-my-pi. Its install script does not install
upstream oh-my-pi builds (build service, npm, Homebrew, mise or source).

To install or update oh-my-tau, run this from an oh-my-tau checkout:

    ./scripts/install-harness.sh

The installer keeps a checkout at ~/.omp/src/oh-my-pi; run the same script
there again to update.
EOF
exit 1
