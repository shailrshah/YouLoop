import type { Loop } from './model';

export interface LoopNode extends Loop {
  children: LoopNode[];
  depth: number;
}

function contains(parent: Loop, child: Loop): boolean {
  return parent.startTime <= child.startTime && child.endTime <= parent.endTime;
}

/**
 * Build a forest of loops nested by *tightest* containment.
 *
 * A loop nests under the deepest existing loop that fully contains it
 * (parent.start <= child.start && child.end <= parent.end). Loops that no
 * open ancestor contains become roots. Crossing intervals (start inside a
 * loop but end past it) attach to the nearest fully-containing ancestor, or
 * become a root if none — documented, deterministic behavior.
 */
export function buildLoopTree(loops: Loop[]): LoopNode[] {
  // start asc, then end desc so a wider loop precedes the narrower ones it
  // contains and becomes their parent.
  const sorted = [...loops].sort(
    (a, b) => a.startTime - b.startTime || b.endTime - a.endTime,
  );

  const roots: LoopNode[] = [];
  const stack: LoopNode[] = []; // chain of currently-open ancestors (wide -> deep)

  for (const loop of sorted) {
    const node: LoopNode = { ...loop, children: [], depth: 0 };

    // Pop ancestors that do not fully contain this loop. Because the stack is
    // a nesting chain, ends grow as you descend, so the first container found
    // walking down is the tightest.
    while (stack.length && !contains(stack[stack.length - 1], node)) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    if (parent) {
      node.depth = parent.depth + 1;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
    stack.push(node);
  }

  return roots;
}
