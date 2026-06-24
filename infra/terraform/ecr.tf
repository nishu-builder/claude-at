resource "aws_ecr_repository" "gateway" {
  name                 = "claude-at/gateway"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
}

resource "aws_ecr_repository" "worker" {
  name                 = "claude-at/worker"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
}
