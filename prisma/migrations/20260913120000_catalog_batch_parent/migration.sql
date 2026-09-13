ALTER TABLE "generic_task" ADD COLUMN "parent_task_id" UUID;

ALTER TABLE "generic_task"
  ADD CONSTRAINT "generic_task_parent_task_id_fkey"
  FOREIGN KEY ("parent_task_id") REFERENCES "generic_task"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "generic_task_parent_status_created_idx"
  ON "generic_task"("parent_task_id", "status", "created_at");
