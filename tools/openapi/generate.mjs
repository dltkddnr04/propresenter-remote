import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withCodegenInput } from './codegen-input.mjs';

const specPath = resolve('openapi/propresenter.openapi.json');
const outputPath = resolve('src/generated/propresenter-api.d.ts');
const generatorPath = resolve('node_modules/openapi-typescript/bin/cli.js');

if (!existsSync(specPath)) throw new Error(`OpenAPI vendor 파일이 없습니다: ${specPath}`);
if (!existsSync(generatorPath)) throw new Error('openapi-typescript가 설치되어 있지 않습니다. npm install을 실행하세요.');

await mkdir(dirname(outputPath), { recursive: true });
await withCodegenInput(async (preparedPath) => {
  const result = spawnSync(process.execPath, [generatorPath, preparedPath, '--output', outputPath, '--immutable', '--enum-values'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`OpenAPI TypeScript 생성 실패 (exit ${result.status ?? 1})`);
});
