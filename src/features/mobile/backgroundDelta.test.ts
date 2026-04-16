import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setRuntimeContext } from '../../platform/runtimeContext';
import {
  ackBackgroundDelta,
  getBackgroundDelta,
} from './backgroundDelta';

describe('backgroundDelta', () => {
  beforeEach(() => {
    setRuntimeContext({
      mode: 'web',
      apiBaseUrl: 'http://localhost:3000',
    });
  });

  it('requests delta with expected query and parses response items', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain('/api/background-runtime/delta?');
      expect(String(url)).toContain('sinceId=3');
      expect(String(url)).toContain('limit=10');
      expect(String(url)).toContain('taskType=group_iteration');
      expect(String(url)).toContain('scopeIds=room-1');
      expect(String(url)).toContain('includeGlobal=false');

      return new Response(
        JSON.stringify({
          ok: true,
          items: [
            {
              id: 7,
              taskType: 'group_iteration',
              scopeId: 'room-1',
              kind: 'state_patch',
              entityType: 'stores',
              entityId: 'job-1',
              payload: { stores: { groupRooms: [] } },
              createdAtMs: 123,
            },
          ],
          nextSinceId: 7,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });

    const result = await getBackgroundDelta(
      {
        sinceId: 3,
        limit: 10,
        taskType: 'group_iteration',
        scopeIds: ['room-1', 'room-1'],
        includeGlobal: false,
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.nextSinceId).toBe(7);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(7);
    expect(result.items[0].scopeId).toBe('room-1');
    expect(result.items[0].kind).toBe('state_patch');
  });

  it('sends ack payload and parses ack response', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe('PUT');
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        ackedUpToId?: number;
        taskType?: string;
      };
      expect(body.ackedUpToId).toBe(11);
      expect(body.taskType).toBe('group_iteration');

      return new Response(
        JSON.stringify({
          ok: true,
          ackedUpToId: 11,
          taskType: 'group_iteration',
          deletedCount: 5,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });

    const result = await ackBackgroundDelta(
      { ackedUpToId: 11, taskType: 'group_iteration' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.ackedUpToId).toBe(11);
    expect(result.taskType).toBe('group_iteration');
    expect(result.deletedCount).toBe(5);
  });
});
