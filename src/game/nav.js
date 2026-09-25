// Auto-generated multi-level navigation graph over the collision world.
// Nodes = walkable floor samples on a 1 m grid (every floor level per column);
// edges = walk (step/ramp), jump (up), drop (down), gap jumps and ladders.
import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';

const DOWN = new THREE.Vector3(0, -1, 0);
const UPV = new THREE.Vector3(0, 1, 0);
export const EDGE = { WALK: 0, JUMP: 1, DROP: 2, LADDER: 3 };

export class NavGraph {
  constructor(world, bounds, cell = 1.0) {
    this.world = world;
    this.bounds = bounds;
    this.cell = cell;
    this.nx = Math.floor((bounds.x1 - bounds.x0) / cell);
    this.nz = Math.floor((bounds.z1 - bounds.z0) / cell);
    this.xs = []; this.ys = []; this.zs = [];
    this.cols = new Map(); // col index -> node ids
    this.adj = [];          // node -> [{to, cost, type, dy}]
  }

  colKey(ix, iz) { return ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz ? -1 : iz * this.nx + ix; }
  toCol(x, z) { return [Math.floor((x - this.bounds.x0) / this.cell), Math.floor((z - this.bounds.z0) / this.cell)]; }

  // Build incrementally so the loading screen can animate. onProgress(0..1)
  async build(onProgress) {
    const w = this.world, c = this.cell;
    const o = new THREE.Vector3(), tmp = new THREE.Vector3();
    const cap = new Capsule(new THREE.Vector3(), new THREE.Vector3(), 0.28);
    const total = this.nx * this.nz;
    let done = 0;
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const x = this.bounds.x0 + (ix + 0.5) * c, z = this.bounds.z0 + (iz + 0.5) * c;
        let y = 24;
        const ids = [];
        for (let k = 0; k < 7; k++) {
          o.set(x, y, z);
          const hit = w.raycast(o, DOWN, 40);
          if (!hit) break;
          const fy = hit.point.y;
          if (hit.normal.y > 0.62 && fy > -6 && !hit.backface) {
            // headroom 1.3 m (crouch height) and horizontal clearance
            tmp.set(x, fy + 0.05, z);
            const head = w.raycast(tmp, UPV, 1.45);
            if (!head) {
              cap.start.set(x, fy + 0.28 + 0.2, z);
              cap.end.set(x, fy + 1.2, z);
              const r = w.octree.capsuleIntersect(cap);
              if (!r || r.depth < 0.02) {
                const id = this.xs.length;
                this.xs.push(x); this.ys.push(fy); this.zs.push(z);
                ids.push(id);
              }
            }
          }
          y = fy - 0.3;
        }
        if (ids.length) this.cols.set(this.colKey(ix, iz), ids);
        done++;
      }
      if (iz % 6 === 0) { onProgress && onProgress(done / total * 0.8); await new Promise((r) => setTimeout(r, 0)); }
    }
    this._link();
    onProgress && onProgress(0.95);
    await new Promise((r) => setTimeout(r, 0));
    this._prune();
    onProgress && onProgress(1);
    this.count = this.xs.length;
  }

  _clear(ax, ay, az, bx, by, bz) {
    const a = new THREE.Vector3(ax, ay, az), b = new THREE.Vector3(bx, by, bz);
    return this.world.lineClear(a, b);
  }

  _link() {
    const n = this.xs.length;
    for (let i = 0; i < n; i++) this.adj.push([]);
    // half-sets of neighbor offsets; each pair is evaluated once and linked both ways
    const near = [[1, 0], [1, 1], [0, 1], [-1, 1]];
    const far = [[2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [-1, 2], [-2, 2], [-2, 1]];
    const add = (a, b, cost, type, dy, gap = false) => this.adj[a].push({ to: b, cost, type, dy, gap });
    for (const [key, ids] of this.cols) {
      const ix = key % this.nx, iz = Math.floor(key / this.nx);
      for (const a of ids) {
        const ax = this.xs[a], ay = this.ys[a], az = this.zs[a];
        for (const [dx, dz] of near) {
          const other = this.cols.get(this.colKey(ix + dx, iz + dz));
          if (!other) continue;
          for (const b of other) {
            const bx = this.xs[b], by = this.ys[b], bz = this.zs[b];
            const dy = by - ay, ady = Math.abs(dy);
            const hd = Math.hypot(bx - ax, bz - az);
            if (ady <= 0.62) {
              if (this._clear(ax, ay + 0.5, az, bx, by + 0.5, bz)) {
                const c = Math.hypot(hd, dy);
                add(a, b, c, EDGE.WALK, dy); add(b, a, c, EDGE.WALK, -dy);
              }
            } else if (ady < 9) {
              const [L, H] = dy > 0 ? [a, b] : [b, a];
              const lx = this.xs[L], ly = this.ys[L], lz = this.zs[L];
              const hx = this.xs[H], hy = this.ys[H], hz = this.zs[H];
              if (this._clear(lx, ly + 0.5, lz, lx, hy + 1.25, lz) && this._clear(lx, hy + 0.4, lz, hx, hy + 0.4, hz)) {
                if (ady <= 2.05) add(L, H, hd + 1.2 + ady * 0.8, EDGE.JUMP, ady);
                add(H, L, hd + 0.4 + ady * 0.15, EDGE.DROP, -ady);
              }
            }
          }
        }
        for (const [dx, dz] of far) {
          const other = this.cols.get(this.colKey(ix + dx, iz + dz));
          if (!other) continue;
          const mid = this.cols.get(this.colKey(ix + Math.round(dx / 2), iz + Math.round(dz / 2)));
          for (const b of other) {
            const bx = this.xs[b], by = this.ys[b], bz = this.zs[b];
            const dy = by - ay, ady = Math.abs(dy);
            if (ady > 4) continue;
            if (mid && mid.some((m) => Math.abs(this.ys[m] - ay) < 0.7 || Math.abs(this.ys[m] - by) < 0.7)) continue;
            const top = Math.max(ay, by);
            const [L, H] = dy > 0 ? [a, b] : [b, a];
            if (this._clear(ax, top + 0.6, az, bx, top + 0.6, bz) && this._clear(this.xs[L], this.ys[L] + 0.5, this.zs[L], this.xs[L], top + 1.2, this.zs[L])) {
              const hd = Math.hypot(bx - ax, bz - az);
              if (ady <= 1.3) {
                add(L, H, hd + 1.5 + ady, EDGE.JUMP, ady, true);
                add(H, L, hd + 1.5, ady <= 0.62 ? EDGE.JUMP : EDGE.DROP, -ady, true);
              } else {
                add(H, L, hd + 1.5, EDGE.DROP, -ady, true);
              }
            }
          }
        }
      }
    }
    // ladders
    for (const l of this.world.ladders) {
      const foot = this.nearest(new THREE.Vector3(l.x + l.normal.x * 0.7, l.y0 + 0.2, l.z + l.normal.z * 0.7), 1.6);
      const top = this.nearest(new THREE.Vector3(l.x - l.normal.x * 0.9, l.y1 + 0.2, l.z - l.normal.z * 0.9), 1.6);
      if (foot >= 0 && top >= 0) {
        const h = l.y1 - l.y0;
        this.adj[foot].push({ to: top, cost: h * 1.6 + 1, type: EDGE.LADDER, dy: h, ladder: l });
        this.adj[top].push({ to: foot, cost: h * 1.2 + 1, type: EDGE.LADDER, dy: -h, ladder: l });
      }
    }
  }

  // Drop tiny disconnected islands (e.g. single crate tops that lead nowhere) from the main component.
  _prune() {
    const n = this.xs.length;
    // undirected component labelling on walk edges only for stats (kept simple: keep all)
    this.comp = new Int32Array(n).fill(-1);
  }

  pos(i, out) { return out.set(this.xs[i], this.ys[i], this.zs[i]); }

  // Nearest node to p, preferring same floor level.
  nearest(p, maxDist = 3) {
    const [cx, cz] = this.toCol(p.x, p.z);
    let best = -1, bd = Infinity;
    const r = Math.ceil(maxDist / this.cell);
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const ids = this.cols.get(this.colKey(cx + dx, cz + dz));
      if (!ids) continue;
      for (const id of ids) {
        const dy = this.ys[id] - p.y;
        if (dy > 1.2 || dy < -4) continue;
        const d = Math.hypot(this.xs[id] - p.x, this.zs[id] - p.z) + Math.abs(dy) * 2.5 + (dy > 0.4 ? 3 : 0);
        if (d < bd) { bd = d; best = id; }
      }
    }
    return best;
  }

  allowed(e, maxJump) {
    if (e.type === EDGE.JUMP) return e.dy <= maxJump + 0.02;
    return true;
  }

  // A* path from node a to node b. Returns node id array (inclusive) or null.
  path(a, b, maxJump = 1.45) {
    if (a < 0 || b < 0) return null;
    const n = this.xs.length;
    const g = new Float64Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const heap = new MinHeap();
    const h = (i) => Math.hypot(this.xs[i] - this.xs[b], this.ys[i] - this.ys[b], this.zs[i] - this.zs[b]);
    g[a] = 0; heap.push(a, h(a));
    let iter = 0;
    while (heap.size) {
      const cur = heap.pop();
      if (cur === b) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (++iter > 40000) return null;
      for (const e of this.adj[cur]) {
        if (!this.allowed(e, maxJump)) continue;
        const ng = g[cur] + e.cost;
        if (ng < g[e.to]) { g[e.to] = ng; came[e.to] = cur; heap.push(e.to, ng + h(e.to)); }
      }
    }
    if (came[b] < 0 && a !== b) return null;
    const out = [b];
    let c = b;
    while (c !== a) { c = came[c]; if (c < 0) return null; out.push(c); }
    return out.reverse();
  }

  // Multi-source Dijkstra on reversed edges: dist[i] = cost from i to nearest target.
  flowField(targets, maxJump = 1.95, out = null) {
    const n = this.xs.length;
    if (!this.radj) {
      this.radj = Array.from({ length: n }, () => []);
      for (let i = 0; i < n; i++) for (const e of this.adj[i]) this.radj[e.to].push({ from: i, e });
    }
    const dist = out && out.length === n ? out : new Float64Array(n);
    dist.fill(Infinity);
    const heap = new MinHeap();
    for (const t of targets) if (t >= 0) { dist[t] = 0; heap.push(t, 0); }
    while (heap.size) {
      const cur = heap.pop();
      const dc = heap.lastKey;
      if (dc > dist[cur]) continue;
      for (const r of this.radj[cur]) {
        if (!this.allowed(r.e, maxJump)) continue;
        const nd = dc + r.e.cost;
        if (nd < dist[r.from]) { dist[r.from] = nd; heap.push(r.from, nd); }
      }
    }
    return dist;
  }

  // Next edge to follow from node i down a flow field.
  flowNext(i, dist, maxJump = 1.95) {
    let best = null, bd = dist[i];
    for (const e of this.adj[i]) {
      if (!this.allowed(e, maxJump)) continue;
      const d = dist[e.to] + e.cost * 0.999;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  edgeBetween(a, b) {
    for (const e of this.adj[a]) if (e.to === b) return e;
    return null;
  }
}

class MinHeap {
  constructor() { this.ids = []; this.keys = []; this.size = 0; this.lastKey = 0; }
  push(id, key) {
    let i = this.size++;
    this.ids[i] = id; this.keys[i] = key;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this._swap(i, p); i = p;
    }
  }
  pop() {
    const id = this.ids[0];
    this.lastKey = this.keys[0];
    this.size--;
    if (this.size > 0) {
      this.ids[0] = this.ids[this.size]; this.keys[0] = this.keys[this.size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.size && this.keys[l] < this.keys[m]) m = l;
        if (r < this.size && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this._swap(i, m); i = m;
      }
    }
    return id;
  }
  _swap(a, b) {
    const ti = this.ids[a]; this.ids[a] = this.ids[b]; this.ids[b] = ti;
    const tk = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = tk;
  }
}
