#!/bin/sh
set -e

# Function to decode base64 secret if needed
decode_secret() {
  local var_name=$1
  local var_value=$(eval echo \$$var_name)
  local expected_pattern=$2
  
  if [ -z "$var_value" ]; then
    return 0
  fi
  
  # If expected pattern is provided, check if value matches it
  if [ -n "$expected_pattern" ]; then
    if echo "$var_value" | grep -qE "$expected_pattern"; then
      # Already in expected format, no need to decode, but ensure it's exported
      eval export "$var_name=\"$var_value\""
      return 0
    fi
  fi
  
  # Try to decode from base64. `base64 -d` fails on values that are not valid
  # base64 (most plain-text keys), which must not abort the script under `set -e`.
  DECODED=$(echo "$var_value" | base64 -d 2>/dev/null) || DECODED=""
  if [ -n "$DECODED" ]; then
    # If expected pattern is provided, verify decoded value matches
    if [ -n "$expected_pattern" ]; then
      if echo "$DECODED" | grep -qE "$expected_pattern"; then
        eval export "$var_name=\"$DECODED\""
        return 0
      fi
    else
      # No pattern to check, use decoded value
      eval export "$var_name=\"$DECODED\""
      return 0
    fi
  fi
  
  # If expected pattern is required but not matched, return error
  if [ -n "$expected_pattern" ]; then
    return 1
  fi
  
  # No pattern required and decode failed, use original value (ensure it's exported)
  eval export "$var_name=\"$var_value\""
  return 0
}

# Decode DATABASE_URL
if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is not set" >&2
  exit 1
fi

if ! decode_secret "DATABASE_URL" '^(postgresql|postgres)://'; then
  echo "DATABASE_URL is neither a postgres URL nor base64-encoded one" >&2
  exit 1
fi

PROTOCOL=$(echo "$DATABASE_URL" | cut -d: -f1)
if [ "$PROTOCOL" != "postgresql" ] && [ "$PROTOCOL" != "postgres" ]; then
  echo "DATABASE_URL has unsupported protocol '$PROTOCOL'" >&2
  exit 1
fi

# Decode REDIS_URL
if [ -n "$REDIS_URL" ]; then
  if ! decode_secret "REDIS_URL" '^redis://'; then
    echo "REDIS_URL is neither a redis URL nor a base64-encoded one" >&2
    exit 1
  fi
  
  PROTOCOL=$(echo "$REDIS_URL" | cut -d: -f1)
  if [ "$PROTOCOL" != "redis" ]; then
    echo "REDIS_URL has unsupported protocol '$PROTOCOL'" >&2
    exit 1
  fi
fi

decode_secret "OPENAI_API_KEY"
decode_secret "BREVO_API_KEY"
decode_secret "GARMIN_CLIENT_SECRET"
decode_secret "POLAR_CLIENT_SECRET"
decode_secret "POLAR_WEBHOOK_SECRET_KEY"
decode_secret "GOOGLE_GENERATIVE_AI_API_KEY"
decode_secret "STRIPE_SECRET_KEY"
decode_secret "STRIPE_WEBHOOK_SECRET"
decode_secret "STRAVA_WEBHOOK_TOKEN"
# decode_secret "SUUNTO_CLIENT_SECRET"
# decode_secret "SUUNTO_SUBSCRIPTION_KEY"
decode_secret "HASH_PEPPER"
decode_secret "STRIPE_PUBLISHABLE_KEY"
decode_secret "STRIPE_PRICE_IDS"
decode_secret "BETTER_STACK_DSN"
if [ -n "$STRIPE_PRICE_IDS" ]; then
  if ! echo "$STRIPE_PRICE_IDS" | grep -qE '^\{".*"\}$'; then
    STRIPE_PRICE_IDS=$(echo "$STRIPE_PRICE_IDS" | sed 's/^{//;s/}$//' | sed -E 's/([A-Z_]+):([^,}]+)/"\1":"\2"/g' | sed 's/^/{/;s/$/}/')
    export STRIPE_PRICE_IDS
  fi
fi
decode_secret "FIREBASE_FUNCTIONS_URL"

cd /app/libs/database

export DATABASE_URL

if prisma migrate deploy; then
  echo "✓ Migrations completed successfully${NC}"
else
  exit 1
fi

cd /app/apps/api
exec node dist/main.js

