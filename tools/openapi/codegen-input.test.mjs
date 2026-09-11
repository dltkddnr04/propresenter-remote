import { describe, expect, it } from 'vitest';
import { prepareCodegenDocument } from './codegen-input.mjs';

describe('OpenAPI codegen input preparation', () => {
  it('is deterministic, non-mutating, and preserves the known response schema', () => {
    const source = {
      openapi: '3.0.2',
      paths: {
        '/v1/example': {
          get: {
            responses: {
              200: { content: { 'application/json': { schema: { type: 'object', properties: { value: { type: 'string' } } } } } },
              404: 'responses.yaml#/404',
            },
            discriminator: { propertyName: 'type', mapping: { group: 'schemas.yaml#/playlist_group', playlist: 'schemas.yaml#/playlist_data' } },
          },
        },
      },
    };
    const original = JSON.stringify(source);
    const first = prepareCodegenDocument(source);
    const second = prepareCodegenDocument(source);
    expect(JSON.stringify(source)).toBe(original);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.paths['/v1/example'].get.discriminator.mapping).toBeUndefined();
    expect(first.paths['/v1/example'].get.responses[200].content['application/json'].schema.properties.value.type).toBe('string');
    expect(first.paths['/v1/example'].get.responses[404].description).toContain('responses.yaml#/404');
  });

  it('fails fast for an unexpected discriminator mapping', () => {
    expect(() => prepareCodegenDocument({ discriminator: { mapping: { unknown: 'schemas.yaml#/not-supported' } } })).toThrow(/discriminator mapping/);
  });

  it('fails fast for an unexpected external reference', () => {
    expect(() => prepareCodegenDocument({ $ref: 'other.yaml#/schema' })).toThrow(/외부 OpenAPI reference/);
  });

  it('fails fast for an unresolved local reference', () => {
    expect(() => prepareCodegenDocument({ $ref: '#/components/schemas/Missing' })).toThrow(/local reference/);
  });
});
