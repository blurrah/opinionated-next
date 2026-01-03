#!/bin/bash

DOCS_DIR="$CLAUDE_PROJECT_DIR/.claude/docs/nextjs"
TIMESTAMP_FILE="$DOCS_DIR/.last-updated"
MAX_AGE_DAYS=7

if [ ! -d "$DOCS_DIR" ]; then
  echo "Next.js docs not found. Run 'bun run docs:update' to download them."
  exit 0
fi

if [ ! -f "$TIMESTAMP_FILE" ]; then
  echo "Next.js docs timestamp missing. Run 'bun run docs:update' to refresh."
  exit 0
fi

last_updated=$(cat "$TIMESTAMP_FILE")
last_updated_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${last_updated%%.*}" "+%s" 2>/dev/null || date -d "$last_updated" "+%s" 2>/dev/null)
now_epoch=$(date "+%s")
age_days=$(( (now_epoch - last_updated_epoch) / 86400 ))

if [ "$age_days" -ge "$MAX_AGE_DAYS" ]; then
  echo "Next.js docs are ${age_days} days old. Run 'bun run docs:update' to refresh."
fi

exit 0
