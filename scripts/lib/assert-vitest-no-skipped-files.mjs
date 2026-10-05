#!/usr/bin/env node
// B-31：真实库运行器共用的"禁止整文件跳过"硬断言。
//
// 背景（B-8 同款）：这些真实库测试文件都用 `describe.skipIf(!enabled)` 做环境开关，
// 开关缺失时 vitest 对"整文件全跳过"仍然退出 0，CLI 退出码证明不了一次性库被演练过。
// 本脚本解析 vitest 的 JSON 报告（--reporter=json --outputFile=...），逐文件、逐用例检查：
//   1. 每个声明的文件都必须出现在报告里，且文件状态为 passed；
//   2. 报告里不得出现未声明的文件（运行器传给 vitest 的文件清单与本断言的清单必须逐个一致）；
//   3. 每个文件至少 1 个用例，且全部 passed（零 skipped / pending / todo / failed，没有白名单）；
//   4. 每个文件的通过数不得低于声明的下限（防止有人删用例后仍然"全绿"）；
//   5. 报告总数自洽：pending / todo / failed 均为 0，passed 总数 = 各文件通过数之和。
//
// 用法（工作目录必须是仓库根）：
//   node scripts/lib/assert-vitest-no-skipped-files.mjs <LABEL> <report.json> <相对路径=通过数下限>...
// 通过时打印 `<LABEL>_INTEGRATION=PASS files=N passed=P skipped=0` 与逐文件明细；
// 失败时向 stderr 打印 `<LABEL>_INTEGRATION=FAIL reason=...` 并以退出码 1 结束。

import fs from "node:fs";
import path from "node:path";

const [label, reportPath, ...specs] = process.argv.slice(2);
if (!label || !reportPath || specs.length === 0) {
  console.error("usage: assert-vitest-no-skipped-files.mjs <LABEL> <report.json> <relpath=floor>...");
  process.exit(2);
}

const fail = (reason, detail) => {
  console.error(`${label}_INTEGRATION=FAIL reason=${reason}`);
  for (const line of detail) console.error(`  ${line}`);
  process.exit(1);
};

const realOrResolved = (target) => {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
};

const required = new Map();
for (const spec of specs) {
  const at = spec.lastIndexOf("=");
  const rel = at > 0 ? spec.slice(0, at) : "";
  const floor = at > 0 ? Number(spec.slice(at + 1)) : Number.NaN;
  if (!rel || !Number.isInteger(floor) || floor < 1) fail("bad_spec", [spec]);
  if (!fs.existsSync(rel)) fail("required_file_missing_on_disk", [rel]);
  required.set(realOrResolved(rel), { rel, floor });
}

if (!fs.existsSync(reportPath)) fail("report_missing", [reportPath]);
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));

const byPath = new Map();
for (const file of report.testResults ?? []) byPath.set(realOrResolved(file.name ?? ""), file);

const missing = [...required.values()].filter(({ rel }) => !byPath.has(realOrResolved(rel))).map(({ rel }) => rel);
if (missing.length > 0) fail("file_not_in_report", missing);

const unexpected = [...byPath.keys()].filter((abs) => !required.has(abs)).map((abs) => path.relative(process.cwd(), abs));
if (unexpected.length > 0) fail("unexpected_file_in_report", unexpected);

const offenders = [];
const lines = [];
let passedTotal = 0;
for (const [abs, { rel, floor }] of required) {
  const file = byPath.get(abs);
  const results = file.assertionResults ?? [];
  const passed = results.filter((test) => test.status === "passed").length;
  const notPassed = results.filter((test) => test.status !== "passed");
  passedTotal += passed;
  if (file.status !== "passed" || results.length === 0 || passed === 0 || notPassed.length > 0) {
    const kinds = [...new Set(notPassed.map((test) => test.status))].join(",") || "none";
    offenders.push(`${rel} file_status=${file.status} cases=${results.length} passed=${passed} not_passed=${notPassed.length}(${kinds})`);
  } else if (passed < floor) {
    offenders.push(`${rel} passed=${passed} < required_floor=${floor}`);
  }
  lines.push(`${rel} passed=${passed} skipped=0`);
}
if (offenders.length > 0) fail("file_skipped_or_not_executed", offenders);

if (report.numPendingTests !== 0 || report.numTodoTests !== 0 || report.numFailedTests !== 0
    || report.numPassedTests !== passedTotal) {
  fail("totals_mismatch", [
    `passed=${report.numPassedTests} pending=${report.numPendingTests} todo=${report.numTodoTests} failed=${report.numFailedTests} sum_of_files=${passedTotal}`,
  ]);
}

for (const line of lines) console.log(`  ${line}`);
console.log(`${label}_INTEGRATION=PASS files=${required.size} passed=${passedTotal} skipped=0`);
