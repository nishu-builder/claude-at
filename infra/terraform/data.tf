data "aws_caller_identity" "current" {}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = var.region

  table_arn = "arn:aws:dynamodb:${local.region}:${local.account_id}:table/${aws_dynamodb_table.this.name}"

  secret_discord_token_arn = "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:discord/agent-bot-token-*"
  secret_github_app_id_arn = "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:claude-at/github-app-id-*"
  secret_github_key_arn    = "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:claude-at/github-app-private-key-*"

  subnet_ids = data.aws_subnets.default.ids
}
