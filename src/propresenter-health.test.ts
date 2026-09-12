import { describe, expect, it } from 'vitest';
import { connectionHealth } from './propresenter-session';

describe('session connection health', () => {
  const state = { revision: 1 } as never;

  it('starts connecting before the first successful snapshot', () => {
    expect(connectionHealth({ isError: false, error: null }, null, null, 1000).status).toBe('connecting');
  });

  it('reports an initial polling failure instead of remaining in checking forever', () => {
    expect(connectionHealth({ isError: true, error: new Error('offline') }, null, null, 1000)).toEqual({ status: 'error', error: 'offline' });
  });

  it('keeps the last known good state connected during the grace window', () => {
    expect(connectionHealth({ isError: true, error: new Error('temporary') }, state, 1000, 5_999)).toEqual({ status: 'connected', error: null });
  });

  it('reports an error after five seconds without a successful poll', () => {
    expect(connectionHealth({ isError: true, error: new Error('offline') }, state, 1000, 6_000)).toEqual({ status: 'error', error: 'offline' });
  });

  it('keeps output diagnostics while the session remains connected', () => {
    expect(connectionHealth({ isError: false, error: null }, state, 1000, 2_000, new Error('status decode failed'))).toEqual({ status: 'connected', error: 'status decode failed' });
  });
});
