#!/usr/bin/env node
// 리포 관리자용 검사기. 학습자에게는 필요 없다.
// 검사: 커리큘럼 형식·선수 관계(R2), 국내 근거·글로벌 비교 칸·구분·적용 대상·법령 근거 비율(R10), 출처 참조·조회일(R11), 졸업 산출물 항목(R12), 경계·연결(R13), 미리 만든 시각 자료 없음(R5), 설정 JSON 유효성.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

const LEVELS = ["Explain", "Apply", "Evaluate", "Develop"];
const FIELDS = ["선수", "핵심 질문", "목표", "만들어 볼 것", "국내 근거", "글로벌 비교"];
const GO_AREAS = ["go-security", "go-control", "go-corporate-communications", "go-hse", "go-scm", "go-mis", "go-general-affairs", "go-leadership-negotiation", "go-cx", "go-esg", "go-finance", "go-develop", "go-ai", "go-compliance-and-legal", "go-operations", "go-icfr"];
const STATUSES = ["확인", "부분", "미확인"];

const KINDS = ["법률", "시행령", "고시", "행정규칙", "표준", "인증기준", "지침", "발표", "규정", "지침서"];
const STATUTORY = ["법률", "시행령", "고시", "행정규칙"];
const HEAD = "| id | 명칭 | 기관 | 구분 | 적용 대상 | URL | 조회일 | 확인 상태 | 변동 | 확인 내용 |";

function parseSources(text) {
  const sources = new Map();
  const problems = [];
  if (!text.includes(HEAD)) problems.push("sources.md 머리 행 형식 오류");
  for (const line of text.split("\n")) {
    if (!/^\| (KR|GL)-/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length !== 10) { problems.push(`sources.md 칸 수 오류: ${cells[0]}`); continue; }
    const [id, name, org, kind, target, url, checked, status, change, note] = cells;
    if (status !== "미확인" && !note) problems.push(`${id}: 확인 내용 없음`);
    if (sources.has(id)) problems.push(`sources.md 중복 id: ${id}`);
    if (!name || !org) problems.push(`${id}: 명칭·기관 없음`);
    if (!KINDS.includes(kind)) problems.push(`${id}: 구분 값 오류 ${kind}`);
    if (!target) problems.push(`${id}: 적용 대상 없음`);
    const urls = url.match(/https:\/\/[^\s)>]+/g) || [];
    if (!urls.length) problems.push(`${id}: 공식 URL 없음`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checked)) problems.push(`${id}: 조회일 형식 오류`);
    if (!STATUSES.includes(status)) problems.push(`${id}: 확인 상태 값 오류 ${status}`);
    if (!["", "잦음"].includes(change)) problems.push(`${id}: 변동 칸은 빈칸 또는 잦음`);
    sources.set(id, { status, kind });
  }
  return { sources, problems };
}

const refs = [];
const domestic = new Map();
const boundarySeen = new Set();
// spec.md 경계표의 영역(R13): 모두 map.md 「경계·연결」에 1회 이상 나와야 한다.
const BOUNDARY_AREAS = ["go-security", "go-control", "go-corporate-communications", "go-hse", "go-scm", "go-mis", "go-general-affairs", "go-leadership-negotiation", "go-cx", "go-esg"];
// spec.md R12의 졸업 산출물 최소 항목 핵심어.
const X_KEYWORDS = ["적용 의무", "시간별 영향", "최대 허용 중단 기간", "RTO", "RPO", "최소 운영 수준", "단일 장애점", "중단 시나리오", "연속성 전략", "활성화 기준", "통지 경로", "IT 복구", "훈련", "대응표", "출처"];
function parseCurriculum(text) {
  const modules = new Map();
  const problems = [];
  const blocks = text.split(/^### /m).slice(1);
  for (const block of blocks) {
    const head = block.split("\n")[0];
    const m = head.match(/^([BASCTX]\d+) · (.+)$/);
    if (!m) { problems.push(`모듈 제목 형식 오류: ${head}`); continue; }
    const id = m[1];
    if (modules.has(id)) problems.push(`${id}: 중복 id`);
    const fields = {};
    for (const line of block.split("\n").slice(1)) {
      const f = line.match(/^- ([^:]+): (.+)$/);
      if (f) fields[f[1]] = f[2];
    }
    for (const name of FIELDS) if (!fields[name]) problems.push(`${id}: 「${name}」 없음`);
    for (const [name, prefix] of [["국내 근거", "KR-"], ["글로벌 비교", "GL-"]]) {
      const ids = (fields[name] || "").split(",").map((x) => x.trim()).filter(Boolean);
      if (!ids.some((x) => x.startsWith(prefix))) problems.push(`${id}: 「${name}」에 ${prefix} 출처 없음`);
      refs.push(...ids.map((x) => [id, x]));
    }
    if (fields["경계·연결"] && !GO_AREAS.some((a) => fields["경계·연결"].includes(a))) problems.push(`${id}: 경계·연결에 go-* 영역 이름 없음`);
    if (id.startsWith("X")) {
      const must = fields["산출물 필수 항목"] || "";
      if (!must) problems.push(`${id}: 「산출물 필수 항목」 없음`);
      for (const k of X_KEYWORDS) if (must && !must.includes(k)) problems.push(`${id}: 산출물 필수 항목에 「${k}」 없음`);
    }
    domestic.set(id, (fields["국내 근거"] || "").split(",").map((x) => x.trim()).filter(Boolean));
    if (fields["경계·연결"]) for (const a of BOUNDARY_AREAS) if (fields["경계·연결"].includes(a)) boundarySeen.add(a);
    if (fields["목표"] && !LEVELS.some((l) => fields["목표"].startsWith(`${l} — `))) problems.push(`${id}: 목표 수준 형식 오류`);
    const prereq = !fields["선수"] || fields["선수"] === "없음" ? [] : fields["선수"].split(",").map((s) => s.trim());
    modules.set(id, prereq);
  }
  for (const [id, prereq] of modules) for (const p of prereq) if (!modules.has(p)) problems.push(`${id}: 없는 선수 ${p}`);
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 2 || !modules.has(id)) return;
    if (state.get(id) === 1) { problems.push(`선수 순환: ${[...path, id].join(" → ")}`); return; }
    state.set(id, 1);
    for (const p of modules.get(id)) visit(p, [...path, id]);
    state.set(id, 2);
  };
  for (const id of modules.keys()) visit(id, []);
  return { modules, problems };
}

function findVisualAssets(files) {
  const allowedJs = /^tools\/.*\.m?js$/;
  return files.filter((f) => /\.(html?|css|svg|png|jpe?g|gif|webp|avif)$/i.test(f) || (/\.m?js$/i.test(f) && !allowedJs.test(f)));
}

function findTemplateMarkup(name, text) {
  const hits = [];
  for (const m of text.matchAll(/(```|~~~)[\s\S]*?\1/g)) if (/<(!doctype|html|svg|style|canvas|script)\b/i.test(m[0])) hits.push(name);
  return hits;
}

function main() {
  const mapText = read("curriculum/map.md");
  const { modules, problems } = parseCurriculum(mapText);
  errors.push(...problems);
  const { sources, problems: sp } = parseSources(read("curriculum/sources.md"));
  errors.push(...sp);
  for (const [mod, ref] of refs) {
    if (!sources.has(ref)) errors.push(`${mod}: 없는 출처 ${ref}`);
    else if (sources.get(ref).status === "미확인") errors.push(`${mod}: 미확인 출처 참조 ${ref}`);
  }
  if (/제\s?\d+\s?조/.test(mapText)) errors.push("map.md에 조문 번호 금지(sources.md에만 둔다)");
  const nonX = [...domestic.keys()].filter((m) => !m.startsWith("X"));
  const noStat = nonX.filter((m) => !domestic.get(m).some((r) => STATUTORY.includes(sources.get(r)?.kind)));
  if (nonX.length && noStat.length / nonX.length > 0.25) errors.push(`국내 법령 근거 없는 모듈 ${noStat.length}/${nonX.length} > 25%: ${noStat.join(", ")}`);
  for (const a of BOUNDARY_AREAS) if (!boundarySeen.has(a)) errors.push(`경계·연결에 ${a}가 한 번도 없음`);
  const used = new Set(refs.map(([, r]) => r));
  for (const id of sources.keys()) if (!used.has(id)) errors.push(`sources.md의 ${id}를 어느 모듈도 쓰지 않음`);
  if (modules.size === 0) errors.push("모듈을 찾지 못함");

  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const f of findVisualAssets(files)) errors.push(`미리 만든 시각 자료 금지: ${f}`);
  for (const f of files.filter((x) => x.endsWith(".md") && existsSync(join(root, x)))) for (const n of findTemplateMarkup(f, read(f))) errors.push(`복사용 마크업 금지: ${n}`);

  for (const p of [".claude/settings.json", "learner-template/state.json"]) {
    try { JSON.parse(read(p)); } catch (e) { errors.push(`${p}: JSON 오류 ${e.constructor.name}`); }
  }
  if (!existsSync(join(root, "learner-template/log.md"))) errors.push("learner-template/log.md 없음");
  for (const s of readdirSync(join(root, ".claude/skills"))) {
    if (statSync(join(root, ".claude/skills", s)).isDirectory() && !existsSync(join(root, ".claude/skills", s, "SKILL.md"))) errors.push(`스킬 ${s}: SKILL.md 없음`);
  }
  if (!read(".gitignore").split("\n").includes("learner/")) errors.push(".gitignore에 learner/ 없음");

  if (errors.length) { console.error(errors.map((e) => `FAIL ${e}`).join("\n")); process.exit(1); }
  console.log(`OK 모듈 ${modules.size}개, 출처 ${sources.size}개, 파일 ${files.length}개 검사`);
}

main();
