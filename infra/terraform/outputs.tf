output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "worker_taskdef_family" {
  value = aws_ecs_task_definition.worker.family
}

output "gateway_service_name" {
  value = aws_ecs_service.gateway.name
}

output "worker_subnets_csv" {
  value = join(",", local.subnet_ids)
}

output "security_group_id" {
  value = aws_security_group.egress.id
}

output "ecr_gateway_url" {
  value = aws_ecr_repository.gateway.repository_url
}

output "ecr_worker_url" {
  value = aws_ecr_repository.worker.repository_url
}

output "dynamodb_table" {
  value = aws_dynamodb_table.this.name
}

output "audit_bucket" {
  value = aws_s3_bucket.audit.bucket
}

output "memory_bucket" {
  value = aws_s3_bucket.memory.bucket
}
