/**
 * Nodes that would sit on top of each other at the map's zoom, gathered into
 * one. Greedy and in a fixed order: each point joins the first group whose
 * centre is within the radius, or starts one. A few hundred nodes take well
 * under a millisecond, so it is simply redone whenever the zoom or the nodes
 * change, never during a pan, since panning moves every point alike.
 */

export interface Placed<T> {
  item: T;
  /** Pixels at the zoom being clustered for. */
  x: number;
  y: number;
}

export interface Group<T> {
  members: T[];
  x: number;
  y: number;
}

export function clusterPoints<T>(points: Placed<T>[], radius: number): Group<T>[] {
  const groups: Group<T>[] = [];
  const r2 = radius * radius;
  for (const p of points) {
    let home: Group<T> | undefined;
    for (const g of groups) {
      const dx = g.x - p.x;
      const dy = g.y - p.y;
      if (dx * dx + dy * dy <= r2) {
        home = g;
        break;
      }
    }
    if (!home) {
      groups.push({ members: [p.item], x: p.x, y: p.y });
      continue;
    }
    // The centre follows its members, so a group sits where they are.
    const n = home.members.length;
    home.x = (home.x * n + p.x) / (n + 1);
    home.y = (home.y * n + p.y) / (n + 1);
    home.members.push(p.item);
  }
  return groups;
}
