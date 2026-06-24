resource "aws_cloudwatch_log_group" "gateway" {
  name              = "/claude-at/gateway"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/claude-at/worker"
  retention_in_days = 14
}
