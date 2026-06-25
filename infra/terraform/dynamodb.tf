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

  # Sparse index: only items carrying a `status` attribute (i.e. JOB# records)
  # are projected here, so the pool/reaper can Query for queued/running jobs
  # instead of Scanning the whole table on every poll.
  global_secondary_index {
    name            = "status-index"
    hash_key        = "status"
    projection_type = "ALL"
  }
}
