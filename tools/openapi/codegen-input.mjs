import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const vendorPath = resolve('openapi/propresenter.openapi.json');

const KNOWN_EXTERNAL_RESPONSE = 'responses.yaml#/404';
const KNOWN_DISCRIMINATOR_MAPPING = {
  group: 'schemas.yaml#/playlist_group',
  playlist: 'schemas.yaml#/playlist_data',
};

function validateAndNormalizeKnownPatterns(value, location = '$', document = value) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateAndNormalizeKnownPatterns(entry, `${location}[${index}]`, document));
    return;
  }
  const object = value;
  if (typeof object.$ref === 'string') {
    if (!object.$ref.startsWith('#/')) {
      throw new Error(`지원하지 않는 외부 OpenAPI reference: ${location} → ${object.$ref}`);
    }
    if (jsonPointer(document, object.$ref) === undefined) {
      throw new Error(`해석할 수 없는 OpenAPI local reference: ${location} → ${object.$ref}`);
    }
  }
  if (object.discriminator?.mapping) {
    const mapping = object.discriminator.mapping;
    const mappingEntries = mapping && typeof mapping === 'object' && !Array.isArray(mapping) ? Object.entries(mapping) : [];
    if (mappingEntries.length !== Object.keys(KNOWN_DISCRIMINATOR_MAPPING).length || mappingEntries.some(([key, entry]) => KNOWN_DISCRIMINATOR_MAPPING[key] !== entry)) {
      throw new Error(`지원하지 않는 OpenAPI discriminator mapping: ${location}`);
    }
    // The official document references a non-distributed schemas.yaml only from
    // this metadata. Endpoint request/response schemas are not changed.
    delete object.discriminator.mapping;
  }
  // The upstream document also encodes a few shared error responses as a bare
  // external string (rather than an OpenAPI Reference Object). They carry no
  // success payload schema, so retain the status code with a local description
  // for generation while leaving the vendored source untouched.
  if (object.responses && typeof object.responses === 'object' && !Array.isArray(object.responses)) {
    for (const [status, response] of Object.entries(object.responses)) {
      if (typeof response === 'string' && response === KNOWN_EXTERNAL_RESPONSE) {
        object.responses[status] = { description: `External response reference: ${response}` };
      } else if (typeof response === 'string') {
        throw new Error(`지원하지 않는 OpenAPI bare response reference: ${location}/responses/${status}`);
      }
    }
  }
  Object.entries(object).forEach(([key, entry]) => validateAndNormalizeKnownPatterns(entry, `${location}.${key}`, document));
}

function jsonPointer(document, pointer) {
  return pointer.slice(2).split('/').reduce((value, part) => {
    const decoded = part.replace(/~1/g, '/').replace(/~0/g, '~');
    // The upstream document percent-encodes `{uuid}` in a few path keys.
    // Decode only the JSON-pointer token; the vendor file remains untouched.
    let key = decoded;
    try { key = decodeURIComponent(decoded); } catch { /* invalid token is handled as an unresolved reference */ }
    return value?.[key];
  }, document);
}

function inlinePathSchemaReferences(document, value) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((entry) => inlinePathSchemaReferences(document, entry)); return; }
  if (typeof value.$ref === 'string' && value.$ref.startsWith('#/paths/') && value.$ref.endsWith('/schema')) {
    const target = jsonPointer(document, value.$ref);
    if (!target || typeof target !== 'object') throw new Error(`해석할 수 없는 OpenAPI schema reference: ${value.$ref}`);
    delete value.$ref;
    Object.assign(value, JSON.parse(JSON.stringify(target)));
    // A path schema can refer back to another path schema. Do not recurse
    // into the newly inlined tree in this traversal.
    return;
  }
  Object.values(value).forEach((entry) => inlinePathSchemaReferences(document, entry));
}

export function prepareCodegenDocument(document) {
  const prepared = JSON.parse(JSON.stringify(document));
  validateAndNormalizeKnownPatterns(prepared, '$', prepared);
  inlinePathSchemaReferences(prepared, prepared);
  return prepared;
}

export async function withCodegenInput(run) {
  const document = prepareCodegenDocument(JSON.parse(await readFile(vendorPath, 'utf8')));
  // The upstream spec uses JSON-pointer refs into path response schemas. Those
  // are legal OpenAPI, but openapi-typescript currently emits invalid TS for
  // this pattern. Inline them only in the temporary generation input.
  const directory = await mkdtemp(join(tmpdir(), 'propresenter-openapi-'));
  const preparedPath = join(directory, 'propresenter.openapi.json');
  await writeFile(preparedPath, `${JSON.stringify(document)}\n`);
  try {
    return await run(preparedPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
