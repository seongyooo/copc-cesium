#!/usr/bin/env node
/**
 * convert-to-copc.mjs
 *
 * LAS / LAZ / 기타 포인트 클라우드 파일을 COPC(.copc.laz)로 변환합니다.
 * pdal 또는 untwine CLI 중 하나가 PATH에 설치되어 있어야 합니다.
 *
 * 사용법:
 *   node scripts/convert-to-copc.mjs <input-file> [output-file]
 *
 * 예시:
 *   node scripts/convert-to-copc.mjs sample.las
 *   node scripts/convert-to-copc.mjs sample.las out/sample.copc.laz
 *
 * 설치:
 *   pdal    - https://pdal.io/en/stable/download.html
 *             conda install -c conda-forge pdal
 *   untwine - https://github.com/hobuinc/untwine/releases
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename, extname } from 'node:path';

const [,, inputArg, outputArg] = process.argv;

if (!inputArg) {
  console.error('사용법: node scripts/convert-to-copc.mjs <input-file> [output-file]');
  process.exit(1);
}

const inputPath  = resolve(inputArg);
const ext        = extname(inputPath);  // .las / .laz / etc.
const stem       = basename(inputPath, ext);

// 출력 경로 결정: 입력 파일과 같은 디렉터리에 <stem>.copc.laz
const outputPath = outputArg
  ? resolve(outputArg)
  : resolve(dirname(inputPath), `${stem}.copc.laz`);

if (!existsSync(inputPath)) {
  console.error(`입력 파일을 찾을 수 없습니다: ${inputPath}`);
  process.exit(1);
}

mkdirSync(dirname(outputPath), { recursive: true });

// ── 변환 도구 탐색 ──────────────────────────────────────────

function hasCmd(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'pipe' });
  return r.status === 0;
}

function runPdal(input, output) {
  console.log('[pdal] 변환 시작...');
  // pdal translate: writers.copc는 pdal 2.4+ 에서 지원
  const cmd = `pdal translate "${input}" "${output}" --writers.copc.forward=all`;
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

function runUntwine(input, output) {
  console.log('[untwine] 변환 시작...');
  const cmd = `untwine --files="${input}" --output_dir="${dirname(output)}" --output_name="${basename(output, '.laz').replace('.copc', '')}"`;
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

// ── 실행 ────────────────────────────────────────────────────

console.log(`입력: ${inputPath}`);
console.log(`출력: ${outputPath}`);

if (hasCmd('pdal')) {
  runPdal(inputPath, outputPath);
} else if (hasCmd('untwine')) {
  runUntwine(inputPath, outputPath);
} else {
  console.error(`
❌ pdal 또는 untwine이 설치되어 있지 않습니다.

설치 방법:
  conda install -c conda-forge pdal       # pdal (권장)
  # 또는 https://github.com/hobuinc/untwine/releases 에서 untwine 다운로드

변환 없이 바로 COPC 파일을 얻으려면:
  https://viewer.copc.io  (드래그앤드롭 온라인 변환)
`);
  process.exit(1);
}

console.log(`\n✅ 변환 완료: ${outputPath}`);
console.log(`\n사용 예시 (main.js):`);
console.log(`  const COPC_URL = 'http://localhost:5173/${basename(outputPath)}';`);
