import { describe, expect, it } from 'vitest';
import { classifyInstance, summarizeInstances, type InstanceLike } from './instanceStatus';

const inst = (over: Partial<InstanceLike>): InstanceLike => ({
  name: 'i', stillActive: true, lifecycle: 'Sep 25 00:00 → Sep 25 19:53', healthStatus: 'Healthy', ...over,
});

describe('classifyInstance', () => {
  it('is running whatever its health, while still reporting', () => {
    expect(classifyInstance(inst({}))).toBe('running');
    expect(classifyInstance(inst({ healthStatus: 'Degraded' }))).toBe('running');
    expect(classifyInstance(inst({ healthStatus: 'Unhealthy' }))).toBe('running');
  });

  it('is stopped when ARM says so or it stopped reporting before the window ended', () => {
    expect(classifyInstance(inst({ healthStatus: 'Stopped' }))).toBe('stopped');
    expect(classifyInstance(inst({ stillActive: false }))).toBe('stopped');
  });

  it('does not call an instance with no series stopped', () => {
    expect(classifyInstance(inst({ stillActive: false, lifecycle: null }))).toBe('running');
  });
});

describe('summarizeInstances', () => {
  it('splits and counts', () => {
    const s = summarizeInstances([
      inst({ name: 'a' }),
      inst({ name: 'b', healthStatus: 'Degraded' }),
      inst({ name: 'c', stillActive: false }),
    ]);
    expect(s.running.map(i => i.name)).toEqual(['a', 'b']);
    expect(s.stopped.map(i => i.name)).toEqual(['c']);
    expect(s.total).toBe(3);
  });
});
