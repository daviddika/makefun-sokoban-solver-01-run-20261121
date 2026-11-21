// Push-optimal Sokoban solver for make.fun sokoban-solver-01-run-20261121.
//
// Strategy (written from the competition description, not from any solver):
// every level is a one-square-wide hallway with 1-4 small rooms off it, each
// room holding 3-4 boxes and as many goals, and a box pushed out of a room's
// door into the hallway can never come back. So a level's push-optimal count
// is the sum of its rooms' optima: split the level into rooms, solve each
// room push-optimally on its own, and stitch the room solutions together with
// hallway walks. Each room is solved with A* over pushes: the heuristic is
// the cheapest assignment of boxes to goals by Manhattan distance (each push
// moves one box one square, so it never overestimates), pruned by dead
// squares (a box that can never be pulled back onto a goal) and frozen 2x2
// blocks. A state is the boxes' squares plus the player's reachable region,
// named by its lowest square, so walking never creates new states.
//
// Deterministic: no clock, no randomness, no environment reads. Search
// budgets are counted in states, never in time, so two runs write the same
// bytes. Node 22 runs this file as-is (erasable TypeScript only).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four steps: [dx, dy, letter]. Pushes reuse the same letters; the
// checker replays the moves and decides which steps push, so case is free.
const DIRS = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
] as const;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall
  goals: number[];
  boxes: number[]; // sorted
  player: number;
}

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * Dead squares: a square is live when a box standing on it could still be
 * pulled back onto some goal, ignoring the other boxes. Computed by pulling
 * backwards from the goals: a box on x can be pulled onto y = x - d when the
 * player could stand on y - d, i.e. both y and y - d are open floor.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood-fill the squares the player reaches from `from` with `occupied`
 * (a box mask) in the way, marking them in `seen` with `stamp`; returns the
 * lowest square of the region, which names the region in a state's key.
 */
function reach(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed onto `t` is caught in a frozen 2x2 block of
 * walls and boxes with a box off its goal: such a box can never move again.
 */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b])) return true;
    if ((occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in LURD letters. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The player's square after playing `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

// ---------------------------------------------------------------------------
// A* over pushes
// ---------------------------------------------------------------------------

/** A binary min-heap of state ids, ordered by (f, h, insertion order). */
class Heap {
  private f: number[] = [];
  private h: number[] = [];
  private seq: number[] = [];
  private id: number[] = [];
  get size(): number {
    return this.id.length;
  }
  push(f: number, h: number, seq: number, id: number): void {
    const { f: F, h: H, seq: S, id: I } = this;
    F.push(f);
    H.push(h);
    S.push(seq);
    I.push(id);
    let i = I.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (F[p] < f || (F[p] === f && (H[p] < h || (H[p] === h && S[p] <= seq)))) break;
      F[i] = F[p];
      H[i] = H[p];
      S[i] = S[p];
      I[i] = I[p];
      i = p;
    }
    F[i] = f;
    H[i] = h;
    S[i] = seq;
    I[i] = id;
  }
  pop(): number {
    const { f: F, h: H, seq: S, id: I } = this;
    const top = I[0];
    const lf = F.pop()!;
    const lh = H.pop()!;
    const ls = S.pop()!;
    const li = I.pop()!;
    if (I.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < I.length && (F[l] < lf || (F[l] === lf && (H[l] < lh || (H[l] === lh && S[l] < ls))))) m = l;
        if (r < I.length && (F[r] < F[m] || (F[r] === F[m] && (H[r] < H[m] || (H[r] === H[m] && S[r] < S[m]))))) m = r;
        if (m === i) break;
        F[i] = F[m];
        H[i] = H[m];
        S[i] = S[m];
        I[i] = I[m];
        i = m;
      }
      F[i] = lf;
      H[i] = lh;
      S[i] = ls;
      I[i] = li;
    }
    return top;
  }
}

/**
 * Cheapest assignment of boxes to goals by Manhattan distance, over all
 * permutations (at most 4 boxes, so at most 24). One push moves one box one
 * square, so covering a box's Manhattan distance to its goal needs at least
 * that many pushes: this heuristic never overestimates, so A* stays optimal.
 */
function assignmentHeuristic(
  boxes: number[],
  goals: number[],
  w: number,
): number {
  const n = boxes.length;
  // Build the n x n cost matrix of Manhattan distances.
  const cost = new Int32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const b = boxes[i];
      const g = goals[j];
      cost[i * n + j] = Math.abs((b % w) - (g % w)) + Math.abs(((b / w) | 0) - ((g / w) | 0));
    }
  }
  // Brute-force all permutations.
  let best = Infinity;
  const perm = Array.from({ length: n }, (_, i) => i);
  const rec = (k: number, acc: number): void => {
    if (acc >= best) return;
    if (k === n) {
      best = acc;
      return;
    }
    for (let j = k; j < n; j++) {
      [perm[k], perm[j]] = [perm[j], perm[k]];
      rec(k + 1, acc + cost[k * n + perm[k]]);
      [perm[k], perm[j]] = [perm[j], perm[k]];
    }
  };
  rec(0, 0);
  return best;
}

interface PushSolution {
  pushes: number;
  moves: string;
}

/**
 * The push-optimal solution of `level`, or null when the search gives up
 * after `maxStates` expansions. A* over pushes with the assignment
 * heuristic; a state is the boxes' squares plus the player's reachable
 * region (named by its lowest square). Dead squares and frozen 2x2 blocks
 * prune states that can never be solved, so the optimum stands.
 */
function solvePushOptimal(level: Level, maxStates = 500_000): PushSolution | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // State key: the region's lowest square, then the boxes' squares, as
  // digits in base `size` (exact while size ** (boxes + 1) stays under 2**53:
  // at most 5 digits of at most 255 on these boards).
  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  const statesBoxes: number[][] = [level.boxes];
  const statesPlayer: number[] = [level.player];
  const statesG: number[] = [0];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1]; // the box square pushed from (state's parent -> this state)
  const pushTo: number[] = [-1];
  const best = new Map<number, number>(); // key -> best g seen
  const heap = new Heap();
  let seq = 0;

  for (const b of level.boxes) occupied[b] = 1;
  const startLow = reach(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  const h0 = assignmentHeuristic(level.boxes, goals, w);
  best.set(keyOf(level.boxes, startLow), 0);
  heap.push(h0, h0, seq++, 0);

  let found = solved(level.boxes) ? 0 : -1;
  let expansions = 0;
  while (heap.size > 0 && found < 0) {
    const s = heap.pop();
    const boxes = statesBoxes[s];
    const g = statesG[s];
    if (expansions++ >= maxStates) return null;
    for (const b of boxes) occupied[b] = 1;
    reach(level, occupied, statesPlayer[s], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        // The player must reach the square behind the box, and the square
        // ahead must be open floor, live, and not frozen after the push.
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(level, occupied, goal, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((x, y) => x - y);
        const key = keyOf(next, reach(level, occupied, b, mark, ++stamp, stack));
        occupied[t] = 0;
        occupied[b] = 1;
        const ng = g + 1;
        const prevBest = best.get(key);
        if (prevBest !== undefined && prevBest <= ng) continue;
        best.set(key, ng);
        const h = assignmentHeuristic(next, goals, w);
        const id = statesBoxes.length;
        statesBoxes.push(next);
        statesPlayer.push(b);
        statesG.push(ng);
        parent.push(s);
        pushFrom.push(b);
        pushTo.push(t);
        if (solved(next)) {
          found = id;
          break;
        }
        heap.push(ng + h, h, seq++, id);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the push list, then the moves: walk to each push's square, push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const from = pushFrom[s];
    const to = pushTo[s];
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[2];
    player = from;
    boxes = statesBoxes[s];
  }
  return { pushes: path.length, moves };
}

// ---------------------------------------------------------------------------
// Rooms: split, solve each, stitch
// ---------------------------------------------------------------------------

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box standing there reaches no goal) out of the floor, and each connected
 * part left that holds a box is a room. Null when some part holds more or
 * fewer boxes than goals, or a box starts in the hallway: then the level is
 * no set of rooms and the caller falls back to solving it whole.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. A box
 * never leaves its room, so the rooms' optima add up to the level's.
 */
function solveByRooms(level: Level): PushSolution | null {
  const rooms = roomsOf(level);
  if (rooms === null) return null;
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/**
 * Solve one level: room by room first; if the level is no set of rooms, or
 * a room's search gives up, solve the whole level at once. An empty answer
 * is the last resort: it is valid format and scores 0, never an illegal
 * move, and is only reached on a level this generator cannot draw.
 */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  if (level.boxes.length === 0) return '';
  const byRooms = solveByRooms(level);
  if (byRooms !== null) return byRooms.moves;
  const whole = solvePushOptimal(level, 2_000_000);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
