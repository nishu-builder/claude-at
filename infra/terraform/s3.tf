# ----------------------------------------------------------------------------
# Audit bucket (write-only for worker: agent can append but never delete logs)
# ----------------------------------------------------------------------------
resource "aws_s3_bucket" "audit" {
  bucket        = "claude-at-audit-${local.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_versioning" "audit" {
  bucket = aws_s3_bucket.audit.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "audit" {
  bucket = aws_s3_bucket.audit.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ----------------------------------------------------------------------------
# Memory bucket (read/write for worker)
# ----------------------------------------------------------------------------
resource "aws_s3_bucket" "memory" {
  bucket        = "claude-at-memory-${local.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_versioning" "memory" {
  bucket = aws_s3_bucket.memory.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "memory" {
  bucket = aws_s3_bucket.memory.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ----------------------------------------------------------------------------
# Data bucket (read-only for worker: mountable datasets synced into a job).
# Admins upload datasets under a prefix; an identity mounts one by `source`.
# ----------------------------------------------------------------------------
resource "aws_s3_bucket" "data" {
  bucket        = "claude-at-data-${local.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket = aws_s3_bucket.data.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
