import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { withCodegenInput } from './codegen-input.mjs';

const specPath = resolve('openapi/propresenter.openapi.json');
const outputPath = resolve('src/generated/propresenter-api.d.ts');
const generatorPath = resolve('node_modules/openapi-typescript/bin/cli.js');

if (!existsSync(specPath) || !existsSync(outputPath)) throw new Error('OpenAPI vendor 또는 generated type 파일이 없습니다. npm run openapi:generate를 실행하세요.');
await withCodegenInput(async (preparedPath) => {
  const result = spawnSync(process.execPath, [generatorPath, preparedPath, '--output', outputPath, '--immutable', '--enum-values', '--check'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`생성된 OpenAPI 타입이 vendor spec과 일치하지 않습니다 (exit ${result.status ?? 1})`);
});
