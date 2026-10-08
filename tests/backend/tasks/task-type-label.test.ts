import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  TASK_TYPE_LABELS,
  taskTypeDisplay,
  taskTypeLabel,
} from "@/app/(admin)/tasks/_lib/task-type-label";
import { REVENUE_SYNC_TASK_TYPE } from "@/lib/tasks/revenue-sync";
import { createWorkerHandlers } from "../../../worker";

/**
 * v0.5.12：后台任务中心给 `changdu.revenue_sync.v1` 补中文名「畅读收益同步」。
 * 任务中心此前没有任何「任务类型 -> 中文名」登记表（task_type 列一直原样显示），所以这里新建的登记表
 * 只登记需要的类型，未登记类型保持原样；本文件守卫登记表自身的完整性。
 */
describe("任务中心任务类型中文名", () => {
  it("changdu.revenue_sync.v1 登记为「畅读收益同步」（字面量钉死，防止常量与展示一起悄悄改名）", () => {
    expect(REVENUE_SYNC_TASK_TYPE).toBe("changdu.revenue_sync.v1");
    expect(TASK_TYPE_LABELS["changdu.revenue_sync.v1"]).toBe("畅读收益同步");
    expect(taskTypeLabel("changdu.revenue_sync.v1")).toBe("畅读收益同步");
    expect(taskTypeDisplay("changdu.revenue_sync.v1")).toBe("畅读收益同步（changdu.revenue_sync.v1）");
  });

  it("登记的每个 key 都是 worker 里真实注册的任务类型，且中文名非空、无首尾空白", () => {
    const registered = Object.keys(createWorkerHandlers({} as PrismaClient));
    expect(Object.keys(TASK_TYPE_LABELS).length).toBeGreaterThan(0);
    for (const [taskType, label] of Object.entries(TASK_TYPE_LABELS)) {
      expect(registered, `${taskType} 不是已注册的任务类型（改名后这里会悄悄失效）`).toContain(taskType);
      expect(label.trim(), taskType).toBe(label);
      expect(label.length, taskType).toBeGreaterThan(0);
    }
  });

  it("登记表是冻结的，运行期不能被改写", () => {
    expect(Object.isFrozen(TASK_TYPE_LABELS)).toBe(true);
  });

  it("没登记的类型不编一句话：label 为 null，display 原样；原型属性名也不会命中", () => {
    for (const taskType of ["catalog_scan", "promo_link.claim.v1", "moboreader.sync", "", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(taskTypeLabel(taskType), taskType).toBeNull();
      expect(taskTypeDisplay(taskType), taskType).toBe(taskType);
    }
  });

  it("旧名 moboreader.revenue_sync.v1 不登记（迁移注释里的旧名是有意保留的历史，不是现役类型）", () => {
    expect(taskTypeLabel("moboreader.revenue_sync.v1")).toBeNull();
  });
});
