# Push-optimal Sokoban solver — sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/daviddika/makefun-sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/daviddika/makefun-sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver in a single `main.ts` (Node 22, standard
library only, no network, fully deterministic).

## How it works

Every level in this competition is a one-square-wide hallway with 1–4 small
rooms off it, each room holding 3–4 boxes and as many goals — and a box
pushed out of a room's door into the hallway can never be pushed back. So a
level's push-optimal count is the sum of its rooms' optima:

1. **Split** — cut the dead squares of the player's (hallway) row out of the
   floor; each connected part left that holds a box is a room.
2. **Solve each room push-optimally** — A* over pushes. The heuristic is the
   cheapest assignment of boxes to goals by Manhattan distance (each push
   moves one box one square, so it never overestimates). States are pruned by
   dead squares (a box that can never be pulled back onto a goal) and frozen
   2×2 blocks. A state is the boxes' squares plus the player's reachable
   region, named by its lowest square, so walking never creates new states.
3. **Stitch** — solve the rooms in turn, the other rooms' boxes standing as
   walls (on their goals once their room is done), the player walking on from
   where the last room left it.

If a level is no set of rooms, or a room's search gives up, the same A* runs
over the whole level instead. Search budgets are counted in states, never in
time, so two runs write the same bytes.

## Practice results

Push-optimal on all 5 practice instances (checker score **1,000,000**):

| instance | rooms | P\* | solved in |
|----------|-------|-----|-----------|
| i001 | 13 | 13 | 13 pushes |
| i002 | 16 | 16 | 16 pushes |
| i003 | 15 + 14 | 29 | 29 pushes |
| i004 | 15 + 17 + 15 | 47 | 47 pushes |
| i005 | 16 + 14 + 14 + 16 | 60 | 60 pushes |

Also verified on 8 freshly drawn sets from the published generator (40
instances): push-optimal on every one. The whole practice set solves in
about 0.35 s, far inside the 60 s wall budget for a set.

## Run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) and writes
`/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`) for every instance.
