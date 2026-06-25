resource "aws_dynamodb_table" "this" {
  name         = "claude-at"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "status"
    type = "S"
  }

  attribute {
    name = "createdAt"
    type = "S"
  }

  # Sparse index: only items carrying a `status` attribute (i.e. JOB# records)
  # are projected here, so the worker pool can Query for `status = queued`
  # instead of Scanning the whole table. Range key gives FIFO pickup order.
  global_secondary_index {
    name            = "status-index"
    hash_key        = "status"
    range_key       = "createdAt"
    projection_type = "ALL"
  }
}
