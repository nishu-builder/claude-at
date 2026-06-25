terraform {
  required_version = ">= 1.5"

  backend "s3" {
    key            = "claude-at/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "claude-at-tflock"
    encrypt        = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
