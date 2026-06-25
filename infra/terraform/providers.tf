provider "aws" {
  region  = var.region
  profile = var.profile == "" ? null : var.profile
}
