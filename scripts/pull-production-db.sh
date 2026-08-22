#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WRANGLER="$PROJECT_ROOT/node_modules/.bin/wrangler"
STAGING_DIRECTORY="$PROJECT_ROOT/.wrangler/production-snapshot.next"
TEMPORARY_DIRECTORY=$(mktemp -d /tmp/tempo-production-export.XXXXXX)
EXPORT_FILE="$TEMPORARY_DIRECTORY/production.sql"
VALIDATION_FILE="$TEMPORARY_DIRECTORY/validation.json"

cleanup() {
  rm -rf -- "$TEMPORARY_DIRECTORY"
}
trap cleanup 0
trap 'exit 1' 1 2 15

mkdir -p -- "$PROJECT_ROOT/.wrangler"
rm -rf -- "$STAGING_DIRECTORY"

# This is the only remote operation. D1 export is read-only.
"$WRANGLER" d1 export tempo-production \
  --remote --env production --skip-confirmation --output "$EXPORT_FILE"

node "$PROJECT_ROOT/scripts/production-db-snapshot.mjs" normalize "$EXPORT_FILE"

# Every SQL operation is explicitly local and confined to the staging directory.
"$WRANGLER" d1 execute tempo-production \
  --local --env production --persist-to "$STAGING_DIRECTORY" \
  --file "$EXPORT_FILE" --yes

"$WRANGLER" d1 execute tempo-production \
  --local --env production --persist-to "$STAGING_DIRECTORY" \
  --command "PRAGMA foreign_key_check;" --json > "$VALIDATION_FILE"

node "$PROJECT_ROOT/scripts/production-db-snapshot.mjs" validate "$VALIDATION_FILE"
node "$PROJECT_ROOT/scripts/production-db-snapshot.mjs" promote "$STAGING_DIRECTORY"

echo "Production snapshot copied to .wrangler/production-snapshot (local only)."
