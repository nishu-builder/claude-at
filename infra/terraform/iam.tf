data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# ----------------------------------------------------------------------------
# Execution role (shared by gateway + worker task defs)
# ----------------------------------------------------------------------------
resource "aws_iam_role" "execution" {
  name               = "claude-at-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ----------------------------------------------------------------------------
# Gateway task role
# ----------------------------------------------------------------------------
resource "aws_iam_role" "gateway_task" {
  name               = "claude-at-gateway-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "gateway_task" {
  statement {
    sid    = "DynamoAccess"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
      "dynamodb:DeleteItem",
      "dynamodb:Scan",
    ]
    resources = [local.table_arn]
  }

  statement {
    sid       = "DiscordTokenSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.secret_discord_token_arn]
  }

  statement {
    sid       = "StopWorkerTask"
    effect    = "Allow"
    actions   = ["ecs:StopTask"]
    resources = ["arn:aws:ecs:${local.region}:${local.account_id}:task/claude-at/*"]
  }
}

resource "aws_iam_role_policy" "gateway_task" {
  name   = "claude-at-gateway-task"
  role   = aws_iam_role.gateway_task.id
  policy = data.aws_iam_policy_document.gateway_task.json
}

# ----------------------------------------------------------------------------
# Worker task role
# ----------------------------------------------------------------------------
resource "aws_iam_role" "worker_task" {
  name               = "claude-at-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "worker_task" {
  statement {
    sid    = "BedrockInvoke"
    effect = "Allow"
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]
    resources = [
      "arn:aws:bedrock:*::foundation-model/anthropic.*",
      "arn:aws:bedrock:*:${local.account_id}:inference-profile/*",
    ]
  }

  statement {
    sid    = "DynamoAccess"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
      "dynamodb:DeleteItem",
      "dynamodb:Scan",
    ]
    resources = [local.table_arn, local.table_index_arn]
  }

  statement {
    sid     = "Secrets"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      local.secret_discord_token_arn,
      local.secret_github_app_id_arn,
      local.secret_github_key_arn,
    ]
  }

  # Mountable secrets are confined to the `claude-at/data/*` prefix so an
  # identity can only inject secrets an admin placed there — never the bot's
  # own Discord/GitHub credentials above.
  statement {
    sid       = "DataSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.secret_data_prefix_arn]
  }

  statement {
    sid       = "AuditWriteOnly"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.audit.arn}/*"]
  }

  statement {
    sid    = "MemoryReadWrite"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.memory.arn}/*"]
  }

  statement {
    sid       = "MemoryList"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.memory.arn]
  }

  # Mountable datasets: list to diff against the on-worker cache, get to fetch.
  # ListBucket also makes a missing key read as empty rather than 403 (see
  # CLAUDE.md gotcha).
  statement {
    sid    = "DataReadOnly"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:ListBucket",
    ]
    resources = [aws_s3_bucket.data.arn, "${aws_s3_bucket.data.arn}/*"]
  }

  # The reaper sweeps for jobs left `running` by dead workers; it needs to ask
  # ECS which task ARNs are still alive. DescribeTasks isn't resource-scopable.
  statement {
    sid       = "DescribeTasksForReaper"
    effect    = "Allow"
    actions   = ["ecs:DescribeTasks"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "worker_task" {
  name   = "claude-at-worker-task"
  role   = aws_iam_role.worker_task.id
  policy = data.aws_iam_policy_document.worker_task.json
}
