import { describe, expect, it } from 'vitest';
import { apiBase, ProPresenterClient } from './propresenter-client';
import { App, loadConnectionSettings, SessionApp } from './main';
import { ProPresenterSessionProvider, readSnapshot } from './propresenter-session';

const settings = { host: '172.30.1.51', port: 1025 };

describe('application bootstrap regression', () => {
  it('keeps saved settings, mounts the session provider, and starts all canonical root requests', async () => {
    const stored = loadConnectionSettings({ getItem: () => JSON.stringify(settings) }, false, { host: '127.0.0.1', port: 1025 });
    expect(stored).toEqual(settings);
    expect(loadConnectionSettings({ getItem: () => '{malformed' }, false, settings)).toBeNull();
    expect(App).toBeTypeOf('function');

    const tree = SessionApp({ settings: stored!, connection: () => undefined });
    expect(tree.type).toBe(ProPresenterSessionProvider);

    const requests: string[] = [];
    const client = new ProPresenterClient(apiBase(stored!), async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes('/presentation/slide_index')) return new Response(JSON.stringify({ presentation_index: { presentation_id: { uuid: 'presentation-a', name: 'A', index: 0 }, index: 0 } }), { status: 200 });
      if (url.includes('/playlist/active')) return new Response(JSON.stringify({ presentation: { playlist: null, item: null }, announcements: { playlist: null, item: null } }), { status: 200 });
      return new Response(JSON.stringify({ current: { uuid: 'current', text: 'Current', notes: '' }, next: null }), { status: 200 });
    });

    await readSnapshot(client, 1);
    expect(requests).toEqual(expect.arrayContaining([
      'http://172.30.1.51:1025/v1/presentation/slide_index?chunked=false',
      'http://172.30.1.51:1025/v1/playlist/active?chunked=false',
      'http://172.30.1.51:1025/v1/status/slide?chunked=false',
    ]));
  });
});
