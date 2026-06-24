#!/usr/bin/env bash
set -euo pipefail

# Build and push the gateway + worker images to ECR.
# Usage: ./scripts/build-and-push.sh [TAG]   (TAG defaults to "latest")

PROFILE="${AWS_PROFILE:-default}"
REGION="${AWS_REGION:-us-east-1}"
TAG="${1:-latest}"

ACCOUNT="$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)"
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

GATEWAY_IMAGE="$REGISTRY/claude-at/gateway:$TAG"
WORKER_IMAGE="$REGISTRY/claude-at/worker:$TAG"

echo "==> Logging in to ECR: $REGISTRY"
aws ecr get-login-password --profile "$PROFILE" --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

# Fargate runs amd64, so always build for linux/amd64 (even from arm64 hosts).
echo "==> Building gateway: $GATEWAY_IMAGE"
docker build --platform linux/amd64 -f docker/gateway.Dockerfile -t "$GATEWAY_IMAGE" .

echo "==> Building worker: $WORKER_IMAGE"
docker build --platform linux/amd64 -f docker/worker.Dockerfile -t "$WORKER_IMAGE" .

echo "==> Pushing gateway: $GATEWAY_IMAGE"
docker push "$GATEWAY_IMAGE"

echo "==> Pushing worker: $WORKER_IMAGE"
docker push "$WORKER_IMAGE"

# Roll the gateway service if it already exists (no-op otherwise).
echo "==> Forcing new gateway deployment (if the service exists)"
aws ecs update-service \
  --cluster claude-at \
  --service claude-at-gateway \
  --force-new-deployment \
  --profile "$PROFILE" \
  --region "$REGION" || true

echo ""
echo "Pushed:"
echo "  $GATEWAY_IMAGE"
echo "  $WORKER_IMAGE"
