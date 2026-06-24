#!/usr/bin/env bash
set -euo pipefail

# Store (or update) a secret in AWS Secrets Manager.
# Usage: store-secret.sh <secret-id> <secret-string>
# Example: ./scripts/store-secret.sh discord/agent-bot-token '<TOKEN>'

if [[ $# -ne 2 ]]; then
  echo "usage: store-secret.sh <secret-id> <secret-string>" >&2
  exit 1
fi

SECRET_ID="$1"
SECRET_STRING="$2"
PROFILE="${AWS_PROFILE:-default}"
REGION="${AWS_REGION:-us-east-1}"

# Create the secret; if it already exists, overwrite its value instead.
if ARN="$(aws secretsmanager create-secret \
  --name "$SECRET_ID" \
  --secret-string "$SECRET_STRING" \
  --profile "$PROFILE" \
  --region "$REGION" \
  --query ARN --output text 2>/dev/null)"; then
  echo "Created secret."
else
  echo "Secret exists; storing a new value."
  ARN="$(aws secretsmanager put-secret-value \
    --secret-id "$SECRET_ID" \
    --secret-string "$SECRET_STRING" \
    --profile "$PROFILE" \
    --region "$REGION" \
    --query ARN --output text)"
fi

echo "ARN: $ARN"
