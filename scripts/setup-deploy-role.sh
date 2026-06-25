#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-sandbox-admin}"
REPO="nishu-builder/claude-at"
ACCOUNT="$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)"
OIDC_ARN="arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com"

if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" --profile "$PROFILE" >/dev/null 2>&1; then
  aws iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 1c58a3a8518e8759bf075b76b750d4f2df264fcd \
    --profile "$PROFILE" >/dev/null
fi

TRUST="$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "${OIDC_ARN}" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:${REPO}:ref:refs/heads/main" }
    }
  }]
}
JSON
)"

if aws iam get-role --role-name claude-at-deploy --profile "$PROFILE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name claude-at-deploy --policy-document "$TRUST" --profile "$PROFILE"
else
  aws iam create-role --role-name claude-at-deploy --assume-role-policy-document "$TRUST" --profile "$PROFILE" >/dev/null
fi

aws iam attach-role-policy --role-name claude-at-deploy --policy-arn arn:aws:iam::aws:policy/AdministratorAccess --profile "$PROFILE"

echo "arn:aws:iam::${ACCOUNT}:role/claude-at-deploy"
