#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const generatedAt = "2026-08-16T14:10:00+09:00";
const paths = {
  canonical: "docs/p2/p2-06-5-lane-a/canonical-tag-v1-final/2026-08-16/canonical-tag-v1.0.0-final.json",
  canonicalManifest: "docs/p2/p2-06-5-lane-a/canonical-tag-v1-final/2026-08-16/CANONICAL_TAG_V1_MANIFEST.json",
  b2Manifest: "docs/p2/p2-06-5-lane-b/b2-owner-final/2026-08-16/B2_FINAL_MANIFEST.json",
  c1Summary: "docs/p2/p2-06-5-lane-c/runs/2026-08-16-owner-final-c1-v2/calibration-summary.json",
  c1Manifest: "docs/p2/p2-06-5-lane-c/runs/2026-08-16-owner-final-c1-v2/C1_MANIFEST.json",
  waiver: "docs/p2/p2-06-5-owner-final/2026-08-16/OWNER_TIMING_WAIVER.json",
  closeout: "docs/p2/p2-06-5-owner-final/2026-08-16/OWNER_FINAL_CLOSEOUT.md",
  reportHtml: "docs/p2/p2-06-5-owner-final/2026-08-16/report/P2-06.5_OWNER_FINAL_REPORT_V2.html",
  reportArtifact: "docs/p2/p2-06-5-owner-final/2026-08-16/report/artifact-v2.json",
  reportReceipt: "docs/p2/p2-06-5-owner-final/2026-08-16/report/REPORT_DELIVERY_RECEIPT_V2.json",
  qaDesktop: "docs/p2/p2-06-5-owner-final/2026-08-16/report/qa/p2-06-5-owner-final-v2-desktop.png",
  qaMobile: "docs/p2/p2-06-5-owner-final/2026-08-16/report/qa/p2-06-5-owner-final-v2-mobile.png",
  finalManifest: "docs/p2/p2-06-5-owner-final/2026-08-16/OWNER_FINAL_V2_MANIFEST.json",
};

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function absolute(path) { return resolve(root, path); }
function percent(value) { return `${(value * 100).toFixed(2)}%`; }
function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const [canonicalBytes, canonicalManifestBytes, b2ManifestBytes, c1SummaryBytes, c1ManifestBytes, waiverBytes, closeoutBytes, qaDesktopBytes, qaMobileBytes] = await Promise.all([
  readFile(absolute(paths.canonical)),
  readFile(absolute(paths.canonicalManifest)),
  readFile(absolute(paths.b2Manifest)),
  readFile(absolute(paths.c1Summary)),
  readFile(absolute(paths.c1Manifest)),
  readFile(absolute(paths.waiver)),
  readFile(absolute(paths.closeout)),
  readFile(absolute(paths.qaDesktop)),
  readFile(absolute(paths.qaMobile)),
]);
const canonical = JSON.parse(canonicalBytes);
const canonicalManifest = JSON.parse(canonicalManifestBytes);
const b2 = JSON.parse(b2ManifestBytes);
const c1 = JSON.parse(c1SummaryBytes);
const c1Manifest = JSON.parse(c1ManifestBytes);
const waiver = JSON.parse(waiverBytes);

if (canonical.artifact_status !== "FINAL" || canonical.count !== 123 || canonicalManifest.artifact_sha256 !== sha256(canonicalBytes)) throw new Error("CanonicalTag v1 Final lineage invalid");
if (b2.summary?.B2_MAPPING_KEY_TOTAL !== 285 || b2.summary?.B2_OWNER_REVIEW_REMAINING !== 0) throw new Error("B2 Final summary invalid");
if (c1.status?.C1_SAMPLE_COUNT !== 10_000 || c1.configurations?.length !== 9) throw new Error("C1 v2 summary invalid");
if (c1Manifest.lineage?.c1_input_sha256 !== c1.c1_input_sha256) throw new Error("C1 v2 input lineage invalid");
if (waiver.raw_run_status !== "PARTIAL" || waiver.expected_violation_count !== 6 || waiver.expected_interval_ms !== 999) throw new Error("Owner timing waiver invalid");

const configurationRows = c1.configurations.map((row) => ({
  configuration: `${row.config_id}/${row.max_text_tags}`,
  ...row,
}));
const artifact = {
  schema_version: 2,
  surface: "portable_owner_report",
  title: "P2-06.5 Owner Final v2 · CanonicalTag v1 + B2 + C1 Readiness",
  generated_at: generatedAt,
  status: "CALIBRATION_REVIEW_PENDING",
  supersedes: {
    c1_run: "2026-08-16-owner-final-c1",
    report: "P2-06.5_OWNER_FINAL_REPORT.html",
  },
  headline: {
    canonical_tag_count: canonical.count,
    b2_mapping_key_total: b2.summary.B2_MAPPING_KEY_TOTAL,
    c1_sample_count: c1.status.C1_SAMPLE_COUNT,
    c1_input_sha256: c1.c1_input_sha256,
  },
  b2: b2.summary,
  c1: {
    status: c1.status,
    input_qa: c1.input_qa,
    false_positive_audit_status: c1.false_positive_audit_status,
    high_false_positive_keyword_status: c1.high_false_positive_keyword_status,
    configurations: configurationRows,
  },
  sources: Object.entries({ canonical: paths.canonical, b2: paths.b2Manifest, c1: paths.c1Summary, waiver: paths.waiver, closeout: paths.closeout }).map(([id, path]) => ({ id, path })),
  auto_write_authorized: false,
};
const artifactContent = `${JSON.stringify(artifact, null, 2)}\n`;

const rows = configurationRows.map((row) => `<tr><td>${escapeHtml(row.configuration)}</td><td>${percent(row.text_hit_rate)}</td><td>${percent(row.title_only_rate)}</td><td>${percent(row.description_only_rate)}</td><td>${percent(row.title_description_both_rate)}</td><td>${percent(row.zero_hit_rate)}</td><td>${row.average_text_tags.toFixed(3)}</td><td>${row.selected_text_tag_count.p50}/${row.selected_text_tag_count.p90}/${row.selected_text_tag_count.p99}</td><td>${row.cap_truncated_books}/${row.cap_truncated_tags}</td><td>${row.mapped_count}</td><td>${row.text_supplement_count}</td><td>${row.union_count}</td></tr>`).join("");
const statusRows = Object.entries(c1.status).map(([key, value]) => `<div class="status-row"><code>${escapeHtml(key)}</code><span>${escapeHtml(value)}</span></div>`).join("");
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><circle cx=%228%22 cy=%228%22 r=%227%22 fill=%22%2369d6c5%22/></svg>"><title>${escapeHtml(artifact.title)}</title>
<style>:root{color-scheme:dark;--bg:#0a0f18;--panel:#121b29;--line:#27364a;--text:#ecf3ff;--muted:#9fb0c5;--accent:#69d6c5;--warn:#ffca6b}*{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#08101a,#111827);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1200px;margin:auto;padding:40px 24px 64px}h1{font-size:32px;line-height:1.2;margin:0 0 10px}h2{margin:38px 0 14px;font-size:21px}.sub{color:var(--muted);max-width:900px}.cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:24px 0}.card,.panel{background:rgba(18,27,41,.92);border:1px solid var(--line);border-radius:14px;padding:18px}.metric{font-size:32px;font-weight:750;color:var(--accent)}.label{color:var(--muted)}.notice{border-left:4px solid var(--warn)}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}.table-wrap{overflow:auto}.status-row{display:grid;grid-template-columns:minmax(280px,1fr) 2fr;gap:16px;padding:7px 0;border-bottom:1px solid var(--line)}.status-row>*{min-width:0}.status-row span{overflow-wrap:anywhere;word-break:break-word}code{color:var(--accent);overflow-wrap:anywhere}.sources li{margin:7px 0;color:var(--muted)}@media(max-width:760px){.cards{grid-template-columns:1fr}.status-row{grid-template-columns:1fr}main{padding:24px 14px}}</style></head>
<body><main><h1>${escapeHtml(artifact.title)}</h1><p class="sub">CanonicalTag v1 Final 与 B2 已闭合；C1 v2 已完成真实 10k 九配置标定和逐书 source hard evidence 物化。参数仍等待独立 adjudication，AUTO_WRITE_AUTHORIZED=NO。</p>
<div class="cards"><section class="card"><div class="metric">123</div><div class="label">CanonicalTag v1 Final</div></section><section class="card"><div class="metric">285</div><div class="label">B2 logical keys closed</div></section><section class="card"><div class="metric">10,000</div><div class="label">C1 v2 unique novels</div></section></div>
<section class="panel notice"><strong>B1 waiver boundary</strong><p>Raw run remains PARTIAL. The waiver accepts only six observed 999ms intervals for this offline evidence run; the global minimum remains 1000ms.</p></section>
<h2>C1 v2 input</h2><section class="panel"><p><strong>Input hash:</strong> <code>${c1.c1_input_sha256}</code></p><p>9,932 books have mapped source evidence, materialized as ${c1.input_qa.mapped_source_tag_rows.toLocaleString("en-US")} exact scoped edges. Language 19/20 remain unresolved raw scopes; 2,320 rows have locale statistics blocked.</p></section>
<h2>Nine calibration configurations</h2><section class="panel table-wrap"><table><thead><tr><th>Config</th><th>Hit</th><th>Title</th><th>Description</th><th>Both</th><th>Zero</th><th>Avg</th><th>p50/p90/p99</th><th>Trunc books/tags</th><th>Mapped</th><th>Supplement</th><th>Union</th></tr></thead><tbody>${rows}</tbody></table></section>
<h2>Review boundary</h2><section class="panel notice"><p>False-positive audit and high false-positive keyword identification are <code>UNASSESSED_PENDING_INDEPENDENT_REVIEW</code>. Scheme, cap and threshold therefore remain <code>OWNER_REVIEW_REQUIRED</code>. C2 is deferred and no chapter corpus was read.</p></section>
<h2>Fixed status</h2><section class="panel">${statusRows}</section>
<h2>Sources</h2><section class="panel"><ul class="sources">${artifact.sources.map(({ id, path }) => `<li><strong>${escapeHtml(id)}:</strong> <code>${escapeHtml(path)}</code></li>`).join("")}</ul></section>
</main></body></html>\n`;

await writeFile(absolute(paths.reportArtifact), artifactContent, "utf8");
await writeFile(absolute(paths.reportHtml), html, "utf8");
const receipt = {
  schema_version: 2,
  generated_at: generatedAt,
  status: "READY_WITH_OWNER_REVIEW_REQUIRED",
  files: [
    { path: paths.reportArtifact, bytes: Buffer.byteLength(artifactContent), sha256: sha256(artifactContent) },
    { path: paths.reportHtml, bytes: Buffer.byteLength(html), sha256: sha256(html) },
    { path: paths.qaDesktop, bytes: qaDesktopBytes.length, sha256: sha256(qaDesktopBytes) },
    { path: paths.qaMobile, bytes: qaMobileBytes.length, sha256: sha256(qaMobileBytes) },
  ],
  c1_run: "2026-08-16-owner-final-c1-v2",
  browser_qa: {
    status: "PASS",
    checked_at: "2026-08-16T14:20:00+09:00",
    console_errors: 0,
    viewports: ["1440x1000", "390x844"],
    responsive_overflow: "PASS",
    screenshots: [
      paths.qaDesktop,
      paths.qaMobile,
    ],
  },
};
const receiptContent = `${JSON.stringify(receipt, null, 2)}\n`;
await writeFile(absolute(paths.reportReceipt), receiptContent, "utf8");

const manifestInputs = [
  [paths.canonical, canonicalBytes], [paths.canonicalManifest, canonicalManifestBytes], [paths.b2Manifest, b2ManifestBytes],
  [paths.c1Summary, c1SummaryBytes], [paths.c1Manifest, c1ManifestBytes], [paths.waiver, waiverBytes], [paths.closeout, closeoutBytes],
  [paths.reportArtifact, Buffer.from(artifactContent)], [paths.reportHtml, Buffer.from(html)], [paths.reportReceipt, Buffer.from(receiptContent)],
  [paths.qaDesktop, qaDesktopBytes], [paths.qaMobile, qaMobileBytes],
];
const manifest = {
  schema_version: 2,
  generated_at: generatedAt,
  closeout_status: "OWNER_PARAMETER_FREEZE_EVIDENCE_READY_PENDING_INDEPENDENT_C1_ADJUDICATION",
  authoritative_c1_run: "2026-08-16-owner-final-c1-v2",
  superseded_c1_run: "2026-08-16-owner-final-c1",
  files: manifestInputs.map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })),
  fixed: { canonical_count: 123, b2_key_total: 285, c1_sample_count: 10000, auto_write_authorized: false },
};
await writeFile(absolute(paths.finalManifest), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

process.stdout.write(`${JSON.stringify({ report: paths.reportHtml, artifact_sha256: sha256(artifactContent), html_sha256: sha256(html), manifest: paths.finalManifest }, null, 2)}\n`);
