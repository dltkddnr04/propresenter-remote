import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const PRO_PRESENTER_OPENAPI_URL = 'https://openapi.propresenter.com/swagger.json';
const outputPath = resolve('openapi/propresenter.openapi.json');

export function normalizeOpenApiSource(source) {
  const withoutBom = source.replace(/^\uFEFF/, '').trim();
  const jsonSource = withoutBom.startsWith('var openapi_spec')
    ? withoutBom.replace(/^var\s+openapi_spec\s*=\s*/, '').replace(/;\s*$/, '')
    : withoutBom;
  const spec = JSON.parse(jsonSource);
  if (typeof spec.openapi !== 'string' || !spec.openapi.startsWith('3.')) {
    throw new Error('공식 ProPresenter 문서가 OpenAPI 3.x 스펙이 아닙니다.');
  }
  return spec;
}

const response = await fetch(PRO_PRESENTER_OPENAPI_URL, { headers: { Accept: 'application/json, text/javascript;q=0.9' } });
if (!response.ok) throw new Error(`OpenAPI 다운로드 실패: ${response.status}`);

const spec = normalizeOpenApiSource(await response.text());
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(spec, null, 2)}\n`);
console.log(`Vendored ProPresenter OpenAPI ${spec.openapi} → ${outputPath}`);
