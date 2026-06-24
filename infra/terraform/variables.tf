variable "region" {
  type    = string
  default = "us-east-1"
}

variable "profile" {
  type    = string
  default = "default"
}

variable "image_tag" {
  type    = string
  default = "latest"
}

variable "default_repo" {
  type    = string
  default = ""
}
