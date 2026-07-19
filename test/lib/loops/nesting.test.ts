import { describe, expect, it } from 'vitest';
import { buildLoopTree } from '@/lib/loops/nesting';
import type { Loop } from '@/lib/loops/model';

// Minimal helper: only the fields buildLoopTree reads. The rest of Loop is
// spread through by object spread, so any string/0/whatever is fine.
const L = (id: string, startTime: number, endTime: number): Loop => ({
  id,
  videoId: 'v',
  label: id,
  startTime,
  endTime,
  speed: 1,
  pitch: 0,
  repeatCount: null,
  playCount: 0,
  createdAt: 0,
  updatedAt: 0,
});

// Flatten to `[id, depth]` pairs in tree-render order — makes assertions
// small and readable.
function flatten(nodes: ReturnType<typeof buildLoopTree>): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const walk = (ns: typeof nodes, depth: number) => {
    for (const n of ns) {
      out.push([n.id, depth]);
      if (n.children.length) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

describe('buildLoopTree', () => {
  it('returns an empty forest for no loops', () => {
    expect(buildLoopTree([])).toEqual([]);
  });

  it('keeps non-overlapping loops as sibling roots in start-time order', () => {
    // Input intentionally out of order so we exercise the sort.
    const tree = buildLoopTree([L('b', 5, 10), L('a', 0, 4), L('c', 20, 30)]);
    expect(flatten(tree)).toEqual([
      ['a', 0],
      ['b', 0],
      ['c', 0],
    ]);
  });

  it('nests a child under the tightest containing parent', () => {
    // outer contains mid contains inner. All three should chain.
    const tree = buildLoopTree([
      L('inner', 4, 6),
      L('outer', 0, 20),
      L('mid', 2, 10),
    ]);
    expect(flatten(tree)).toEqual([
      ['outer', 0],
      ['mid', 1],
      ['inner', 2],
    ]);
  });

  it('handles two siblings under one parent', () => {
    const tree = buildLoopTree([
      L('parent', 0, 20),
      L('left', 2, 5),
      L('right', 10, 15),
    ]);
    expect(flatten(tree)).toEqual([
      ['parent', 0],
      ['left', 1],
      ['right', 1],
    ]);
  });

  it('makes a crossing interval a sibling, not a child', () => {
    // "crosser" starts inside `a` but ends past a.endTime — no ancestor
    // fully contains it, so it becomes a root.
    const tree = buildLoopTree([L('a', 0, 10), L('crosser', 5, 20)]);
    expect(flatten(tree)).toEqual([
      ['a', 0],
      ['crosser', 0],
    ]);
  });

  it('puts the wider loop first when two share a start time', () => {
    // Same start, different end. Wider (b) becomes parent of narrower (a).
    const tree = buildLoopTree([L('a', 0, 5), L('b', 0, 10)]);
    expect(flatten(tree)).toEqual([
      ['b', 0],
      ['a', 1],
    ]);
  });

  it('assigns depth values that match the render order', () => {
    const tree = buildLoopTree([
      L('root', 0, 100),
      L('a', 10, 50),
      L('a1', 15, 25),
      L('b', 60, 90),
    ]);
    // Verify depth via the exposed field, not just via flatten's shape.
    expect(tree[0].depth).toBe(0);
    expect(tree[0].children[0].depth).toBe(1);
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });
});
