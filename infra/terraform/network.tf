resource "aws_security_group" "egress" {
  name        = "claude-at-egress"
  description = "claude-at Fargate egress-only security group"
  vpc_id      = data.aws_vpc.default.id

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
