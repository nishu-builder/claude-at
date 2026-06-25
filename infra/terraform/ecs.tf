resource "aws_ecs_cluster" "this" {
  name = "claude-at"
}

# ----------------------------------------------------------------------------
# Worker task definition (ephemeral, launched per job via ecs:RunTask)
# ----------------------------------------------------------------------------
resource "aws_ecs_task_definition" "worker" {
  family                   = "claude-at-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "1024"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.worker_task.arn

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = "${aws_ecr_repository.worker.repository_url}:${var.image_tag}"
      essential = true
      environment = [
        { name = "CLAUDE_CODE_USE_BEDROCK", value = "1" },
        { name = "AWS_REGION", value = local.region },
        { name = "ANTHROPIC_MODEL", value = "us.anthropic.claude-opus-4-8" },
        { name = "ANTHROPIC_SMALL_FAST_MODEL", value = "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
        { name = "DDB_TABLE", value = aws_dynamodb_table.this.name },
        { name = "CLUSTER", value = aws_ecs_cluster.this.name },
        { name = "AUDIT_BUCKET", value = aws_s3_bucket.audit.bucket },
        { name = "MEMORY_BUCKET", value = aws_s3_bucket.memory.bucket },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.worker.name
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "worker"
        }
      }
    }
  ])
}

# ----------------------------------------------------------------------------
# Worker service (always-on pool, polls DynamoDB for queued jobs)
# ----------------------------------------------------------------------------
resource "aws_ecs_service" "worker" {
  name            = "claude-at-worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_pool_size
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.subnet_ids
    security_groups  = [aws_security_group.egress.id]
    assign_public_ip = true
  }

  depends_on = [
    aws_iam_role_policy.worker_task,
    aws_iam_role_policy_attachment.execution_managed,
    aws_cloudwatch_log_group.worker,
  ]
}

# ----------------------------------------------------------------------------
# Gateway task definition (always-on Discord bot)
# ----------------------------------------------------------------------------
resource "aws_ecs_task_definition" "gateway" {
  family                   = "claude-at-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.gateway_task.arn

  container_definitions = jsonencode([
    {
      name      = "gateway"
      image     = "${aws_ecr_repository.gateway.repository_url}:${var.image_tag}"
      essential = true
      environment = [
        { name = "AWS_REGION", value = local.region },
        { name = "DDB_TABLE", value = aws_dynamodb_table.this.name },
        { name = "CLUSTER", value = aws_ecs_cluster.this.name },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.gateway.name
          "awslogs-region"        = local.region
          "awslogs-stream-prefix" = "gateway"
        }
      }
    }
  ])
}

# ----------------------------------------------------------------------------
# Gateway service (1 always-on task)
# ----------------------------------------------------------------------------
resource "aws_ecs_service" "gateway" {
  name            = "claude-at-gateway"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.gateway.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.subnet_ids
    security_groups  = [aws_security_group.egress.id]
    assign_public_ip = true
  }

  depends_on = [
    aws_iam_role_policy.gateway_task,
    aws_iam_role_policy_attachment.execution_managed,
    aws_cloudwatch_log_group.gateway,
  ]
}
