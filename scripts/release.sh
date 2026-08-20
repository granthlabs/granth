#!/usr/bin/env bash
#
# Publish every package at the version in package.json, in dependency order.
#
#   bash scripts/release.sh --dry-run    # what would go, and in what order
#   bash scripts/release.sh              # publish
#
# Must be run from a REAL TERMINAL. `auth-type` is web, so npm opens a browser
# for approval — and it needs a TTY to do that. Without one it falls back to
# demanding an `--otp` code and every package fails with EOTP.
#
# Three things this fixes, all of which have actually happened to this repo:
#
#   1. `npm publish | sed` reports the exit status of SED. A run where all 14
#      packages failed with EOTP printed "OK" fourteen times and summarised
#      "published 14, failed 0". Nothing here pipes a publish.
#   2. A run that dies partway leaves some packages published. Re-running then
#      hits E403 "cannot publish over 0.2.8" on those, which reads as a failure
#      and is not one. This SKIPS anything already at the target version, so a
#      re-run after any interruption is safe and says what it skipped.
#   3. Publishing continues past a failed dependency. If granth-engine fails and
#      granthdb goes out declaring `^0.2.10` of it, the tarball on npm is broken
#      for everyone who installs it. This stops at the first failure.
#
# It ends by asking the REGISTRY what is published, rather than trusting the
# exit codes it just collected.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

DRY=""
[ "${1:-}" = "--dry-run" ] && DRY="--dry-run"

VER=$(node -p "require('./package.json').version")
echo "release: target version $VER${DRY:+  (dry run)}"

# Check the credentials BEFORE publishing anything.
#
# npm answers an unauthenticated PUT to a package you own with 404, not 401 —
# deliberately, so the registry does not leak which private packages exist. The
# result is that an expired token reports as:
#
#   npm error 404 Not Found - PUT https://registry.npmjs.org/granth-codemod
#   npm error 404  ...could not be found or you do not have permission
#
# which reads as "that package is missing" and sends you looking at the package.
# One `whoami` up front turns it into the sentence it actually is.
if [ -z "$DRY" ]; then
  WHO=$(npm whoami 2>/dev/null)
  if [ -z "$WHO" ]; then
    echo
    echo "release: not logged in to npm — nothing was published."
    echo "         Publishing would fail with a 404 naming the first package,"
    echo "         which is npm's way of saying 401 without leaking what exists."
    echo
    echo "         Run this in a terminal (it opens a browser), then re-run:"
    echo "             npm login"
    exit 1
  fi
  echo "release: authenticated as $WHO"
fi

# Dependency order, derived from the package graph rather than hand-listed: a
# hand-listed order is correct until someone adds a package, and the symptom
# then is a broken tarball on npm rather than an error here.
# `mapfile` would be the obvious thing here and is bash 4+. macOS ships bash 3.2,
# where it silently is not a builtin and the array stays unset.
DIRS=()
while IFS= read -r line; do [ -n "$line" ] && DIRS+=("$line"); done < <(node -e '
const {readFileSync}=require("fs"), {globSync}=require("fs");
const files=[...globSync("packages/*/package.json"),...globSync("packages/*/*/package.json")];
const pkgs={};
for(const f of files){
  const d=JSON.parse(readFileSync(f,"utf8"));
  if(d.private) continue;
  pkgs[d.name]={dir:f.replace(/\/package\.json$/,""),deps:new Set([...Object.keys(d.dependencies||{}),...Object.keys(d.peerDependencies||{})])};
}
const out=[],seen=new Set();
const visit=n=>{if(seen.has(n))return;seen.add(n);
  for(const d of [...pkgs[n].deps].filter(x=>pkgs[x]).sort()) visit(d);
  out.push(n);};
Object.keys(pkgs).sort().forEach(visit);
console.log(out.map(n=>pkgs[n].dir).join("\n"));
')

published=0; skipped=0
for dir in "${DIRS[@]}"; do
  name=$(node -p "require('./$dir/package.json').name")

  if [ -z "$DRY" ] && [ "$(npm view "$name@$VER" version 2>/dev/null)" = "$VER" ]; then
    echo "  skip      $name  (already at $VER)"
    skipped=$((skipped + 1))
    continue
  fi

  echo "  publish   $name@$VER"
  # No pipe. The exit status has to be npm's.
  if ! npm publish $DRY --workspace "$dir"; then
    echo
    echo "release: FAILED on $name. Stopped here so nothing downstream goes out"
    echo "         declaring a dependency that is not on the registry."
    echo "         Fix, then re-run — everything already published is skipped."
    exit 1
  fi
  published=$((published + 1))
done

if [ -n "$DRY" ]; then
  echo "release: $published package(s) would publish at $VER"
  exit 0
fi

# Ask the registry, not the exit codes.
#
# With retries, because the first version of this reported granth-react MISSING
# on a run where all fourteen had in fact published. A package's metadata
# document is not readable the instant `npm publish` returns, and `npm view`
# will also answer from its own cache — so an immediate single check reports a
# successful release as a failed one, which is the same class of lie as the
# pipeline that swallowed npm's exit status.
#
# `--prefer-online` revalidates rather than trusting the local cache.
echo
echo "release: verifying against the registry"
missing=0
for dir in "${DIRS[@]}"; do
  name=$(node -p "require('./$dir/package.json').name")
  seen=""
  for attempt in 1 2 3 4 5; do
    seen=$(npm view --prefer-online "$name@$VER" version 2>/dev/null)
    [ "$seen" = "$VER" ] && break
    sleep 3
  done
  if [ "$seen" != "$VER" ]; then
    echo "  MISSING   $name@$VER  (still not visible after 5 attempts)"
    missing=$((missing + 1))
  fi
done

if [ "$missing" -gt 0 ]; then
  echo "release: $missing package(s) are NOT on the registry. Re-run."
  exit 1
fi
echo "release: all ${#DIRS[@]} packages confirmed at $VER (published $published, skipped $skipped)"
