import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { UsePresenter } from "./hooks/use-presenter";
import { synthesizeExcitedVoice } from "./lib/audio";
import {
  DOOM_ARMOR_ABSORB,
  DOOM_DEMO_MS,
  DOOM_FACE_MARGIN,
  DOOM_IDLE_TRIGGER_MS,
  DOOM_MAP,
  DOOM_MOUSE_SPAWNS,
  DOOM_PLAYER_START,
  DOOM_ROOMS,
  DOOM_START_ARMOR,
  DOOM_TAUNTS_DEATH,
  DOOM_TAUNTS_HURT,
  DOOM_TAUNTS_IDLE,
  DOOM_TAUNTS_KILL,
  DOOM_TAUNTS_START,
  DOOM_TAUNTS_VICTORY,
  DOOM_TAUNT_SPEED,
  DOOM_TAUNT_VOICE,
  DOOM_WEAPONS,
  DOOM_WEAPON_LABELS,
  doomFaceRect,
  pickDoomTaunt,
  type DoomCell,
  type DoomRoom,
  type DoomRoomId,
  type DoomWallTex,
  type DoomWeapon,
} from "./lib/easter-eggs";

// Internal framebuffer resolution — deliberately low-res + `imageRendering:
// pixelated` on the way up to the real canvas size, same "1993, not 2026"
// look the codec/AYB eggs get from CRT scanlines rather than realism.
const RES_W = 320;
const RES_H = 200;
const FOV = 1.15; // ~66°, classic Doom's horizontal FOV
const MOVE_SPEED = 2.2; // tiles/sec
const TURN_SPEED = 2.6; // rad/sec
const MOUSE_HP = 45;
const MOUSE_SPEED = 1.35;
const MOUSE_AGGRO = 6.5;
const MOUSE_MELEE_RANGE = 0.55;
const MOUSE_DMG_MIN = 7;
const MOUSE_DMG_MAX = 13;
const END_HOLD_S = 1.6;

type Mode = "wait" | "demo" | "live" | "dead" | "cleared" | "ending";

interface Player {
  x: number;
  y: number;
  angle: number;
  health: number;
  armor: number;
  weapon: DoomWeapon;
  ammoCheese: number;
  ammoTrap: number;
  fireCooldown: number;
  meleeSwipeT: number;
  hurtFlash: number;
  bobT: number;
}
interface Mouse {
  x: number;
  y: number;
  hp: number;
  alive: boolean;
  hurtT: number;
  deathT: number;
  attackCooldown: number;
}
interface Projectile {
  x: number;
  y: number;
  dx: number;
  dy: number;
  kind: "cheese" | "trap";
  life: number;
}
interface Spark {
  x: number;
  y: number;
  life: number;
}
interface GameState {
  player: Player;
  mice: Mouse[];
  projectiles: Projectile[];
  sparks: Spark[];
  mode: Mode;
  modeT: number;
  keys: Set<string>;
  taunting: boolean;
  idleTauntT: number;
  zbuffer: Float32Array;
  doorOpen: number; // 0 closed .. 1 fully retracted (the single map door)
  doorTouching: boolean; // player is in the door cell (holds it open)
  messageT: number; // countdown for the transient status-bar message
}

// Cell access in tile coords. Returns undefined out of bounds (treated as
// solid) so the raycast/movement never see "the void" as walkable.
function cellAt(tx: number, ty: number): DoomCell | undefined {
  return DOOM_MAP[ty]?.[tx];
}
// Resolve a cell to its room descriptor (falls back to the hangar look so an
// out-of-bounds/unknown sample never produces a blank floor).
function roomOfCell(cell: DoomCell | undefined): DoomRoom {
  return cell ? DOOM_ROOMS[cell.room] : DOOM_ROOMS.hangar;
}
function cellSolid(cell: DoomCell | undefined, doorOpen: number): boolean {
  if (!cell) return true;
  if (cell.type === "floor") return false;
  if (cell.type === "door") return doorOpen < 0.85; // solid until fully retracted
  return true; // wall / window / exit
}
function collides(x: number, y: number, r: number, doorOpen: number): boolean {
  const pts = [[x - r, y - r], [x + r, y - r], [x - r, y + r], [x + r, y + r]];
  for (const [px, py] of pts) {
    if (cellSolid(cellAt(Math.floor(px), Math.floor(py)), doorOpen)) return true;
  }
  return false;
}
function tryMove(ent: { x: number; y: number }, dx: number, dy: number, r: number, doorOpen: number) {
  if (!collides(ent.x + dx, ent.y, r, doorOpen)) ent.x += dx;
  if (!collides(ent.x, ent.y + dy, r, doorOpen)) ent.y += dy;
}
// Combines forward/back with sideways strafe (perpendicular to facing) into
// one move — shared by live input and the demo autopilot so both actually
// use strafing, not just turn-and-walk. +strafe is to the right of facing
// (angle+90°), matching the same clockwise convention turn already uses
// (ArrowRight increases player.angle).
function applyMovement(player: Player, forward: number, strafe: number, dt: number, doorOpen: number) {
  const moveX = (Math.cos(player.angle) * forward + Math.cos(player.angle + Math.PI / 2) * strafe) * MOVE_SPEED * dt;
  const moveY = (Math.sin(player.angle) * forward + Math.sin(player.angle + Math.PI / 2) * strafe) * MOVE_SPEED * dt;
  tryMove(player, moveX, moveY, 0.2, doorOpen);
}
function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// One column's DDA raycast. Returns the perpendicular distance to the first
// blocking cell (for the z-buffer / sprite occlusion), the fractional u
// coordinate along the wall (for texture sampling), which side it hit
// (0 = x-face/N-S wall, 1 = y-face/E-W wall), the hit cell, and the room the
// ray was traveling through just before it hit (the "near" sector whose
// ceiling height sets how tall this wall looks — the source of the visible
// different ceiling geometry between rooms).
interface RayHit {
  perpDist: number;
  wallX: number;
  wallU: number; // absolute coordinate along the wall face (world units), for repeating the texture
  side: 0 | 1;
  cell: DoomCell | null;
  nearRoomId: DoomRoomId;
  nearRoom: DoomRoom;
}
const DEFAULT_ROOM_ID: DoomRoomId = "hangar";
// `rdx`,`rdy` is the UN-normalized camera-plane ray direction (dir + plane*cameraX).
// With that form the returned `perpDist` is already the true perpendicular
// distance, so the column's wall height/position needs no fish-eye correction —
// the previous per-world-angle rays were missing that and bowed the walls.
function castRay(px: number, py: number, rdx: number, rdy: number, doorOpen: number): RayHit {
  let mapX = Math.floor(px);
  let mapY = Math.floor(py);
  const deltaX = rdx === 0 ? 1e30 : Math.abs(1 / rdx);
  const deltaY = rdy === 0 ? 1e30 : Math.abs(1 / rdy);
  let stepX: number, stepY: number;
  let sideDistX: number, sideDistY: number;
  if (rdx < 0) {
    stepX = -1;
    sideDistX = (px - mapX) * deltaX;
  } else {
    stepX = 1;
    sideDistX = (mapX + 1 - px) * deltaX;
  }
  if (rdy < 0) {
    stepY = -1;
    sideDistY = (py - mapY) * deltaY;
  } else {
    stepY = 1;
    sideDistY = (mapY + 1 - py) * deltaY;
  }
  const startCell = cellAt(mapX, mapY);
  let nearRoomId: DoomRoomId = startCell && startCell.type !== "wall" ? startCell.room : DEFAULT_ROOM_ID;
  let side: 0 | 1 = 0;
  for (let i = 0; i < 80; i++) {
    if (sideDistX < sideDistY) {
      sideDistX += deltaX;
      mapX += stepX;
      side = 0;
    } else {
      sideDistY += deltaY;
      mapY += stepY;
      side = 1;
    }
    const c = cellAt(mapX, mapY);
    if (cellSolid(c, doorOpen)) {
      const perpDist = side === 0 ? sideDistX - deltaX : sideDistY - deltaY;
      let rawU = side === 0 ? py + perpDist * rdy : px + perpDist * rdx;
      const wallX = rawU - Math.floor(rawU);
      // Absolute world coordinate along the wall face so the texture can repeat
      // every tile (real Doom repeats a 128-unit texture; we repeat per tile),
      // which gives the wall visible scale so you can judge position/distance.
      const wallU = rawU;
      return { perpDist, wallX, wallU, side, cell: c ?? null, nearRoomId, nearRoom: DOOM_ROOMS[nearRoomId] };
    }
    if (c && c.type !== "wall") nearRoomId = c.room;
  }
  return { perpDist: 64, wallX: 0, wallU: 0, side, cell: null, nearRoomId, nearRoom: DOOM_ROOMS[nearRoomId] };
}

function freshGame(): GameState {
  return {
    player: {
      x: DOOM_PLAYER_START.x,
      y: DOOM_PLAYER_START.y,
      angle: DOOM_PLAYER_START.angle,
      health: 100,
      armor: DOOM_START_ARMOR,
      weapon: "claws",
      ammoCheese: 8,
      ammoTrap: 3,
      fireCooldown: 0,
      meleeSwipeT: 0,
      hurtFlash: 0,
      bobT: 0,
    },
    mice: DOOM_MOUSE_SPAWNS.map((s) => ({ x: s.x, y: s.y, hp: MOUSE_HP, alive: true, hurtT: 0, deathT: 0, attackCooldown: 0 })),
    projectiles: [],
    sparks: [],
    mode: "wait",
    modeT: 0,
    keys: new Set(),
    taunting: false,
    idleTauntT: 3,
    zbuffer: new Float32Array(RES_W),
    doorOpen: 0,
    doorTouching: false,
    messageT: 0,
  };
}

// Doom-style armor: absorbs DOOM_ARMOR_ABSORB of every hit until it runs
// out, then damage goes straight to health.
function applyDamage(player: Player, dmg: number) {
  if (player.armor > 0) {
    const absorbed = Math.min(player.armor, dmg * DOOM_ARMOR_ABSORB);
    player.armor -= absorbed;
    player.health -= dmg - absorbed;
  } else {
    player.health -= dmg;
  }
}

function damageMouse(m: Mouse, dmg: number, onKill: () => void) {
  if (!m.alive) return;
  m.hp -= dmg;
  m.hurtT = 0.2;
  if (m.hp <= 0) {
    m.alive = false;
    m.deathT = 0;
    onKill();
  }
}

function fireWeapon(game: GameState, sfx: (kind: "shoot" | "melee" | "hit" | "kill") => void, onKill: () => void) {
  const { player } = game;
  if (player.fireCooldown > 0) return;
  if (player.weapon === "claws") {
    player.fireCooldown = 0.35;
    player.meleeSwipeT = 1;
    sfx("melee");
    for (const m of game.mice) {
      if (!m.alive) continue;
      const dx = m.x - player.x;
      const dy = m.y - player.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1.1) continue;
      const rel = normalizeAngle(Math.atan2(dy, dx) - player.angle);
      if (Math.abs(rel) < 0.6) {
        damageMouse(m, 26, onKill);
        game.sparks.push({ x: m.x, y: m.y, life: 0.25 });
        sfx("hit");
        break;
      }
    }
  } else if (player.weapon === "cheese") {
    if (player.ammoCheese <= 0) return;
    player.fireCooldown = 0.3;
    player.ammoCheese--;
    player.meleeSwipeT = 1;
    sfx("shoot");
    game.projectiles.push({
      x: player.x + Math.cos(player.angle) * 0.3,
      y: player.y + Math.sin(player.angle) * 0.3,
      dx: Math.cos(player.angle) * 7,
      dy: Math.sin(player.angle) * 7,
      kind: "cheese",
      life: 2.2,
    });
  } else {
    if (player.ammoTrap <= 0) return;
    player.fireCooldown = 0.55;
    player.ammoTrap--;
    player.meleeSwipeT = 1;
    sfx("shoot");
    game.projectiles.push({
      x: player.x + Math.cos(player.angle) * 0.3,
      y: player.y + Math.sin(player.angle) * 0.3,
      dx: Math.cos(player.angle) * 4,
      dy: Math.sin(player.angle) * 4,
      kind: "trap",
      life: 1.4,
    });
  }
}

function autopilotStep(game: GameState, dt: number, sfx: (kind: "shoot" | "melee" | "hit" | "kill") => void, onKill: () => void) {
  const { player } = game;
  const alive = game.mice.filter((m) => m.alive);
  let target: Mouse | null = null;
  let bestD = Infinity;
  for (const m of alive) {
    const d = Math.hypot(m.x - player.x, m.y - player.y);
    if (d < bestD) {
      bestD = d;
      target = m;
    }
  }
  let turn = 0;
  let forward = 0;
  let strafe = 0;
  if (target) {
    const dx = target.x - player.x;
    const dy = target.y - player.y;
    const rel = normalizeAngle(Math.atan2(dy, dx) - player.angle);
    turn = Math.max(-1, Math.min(1, rel * 2.2));
    if (Math.abs(rel) < 0.55) forward = bestD > 1.4 ? 1 : 0.25;
    // Weave side-to-side while engaging — reads as "smart" evasive movement
    // and is the demo's own showcase of strafing, not just walk-and-turn.
    strafe = Math.sin(game.modeT * 3) * (bestD < 5 ? 1 : 0.4);
    if (Math.abs(rel) < 0.22) {
      player.weapon = bestD > 3 ? "cheese" : "claws";
      fireWeapon(game, sfx, onKill);
    }
  } else {
    forward = 0.35;
    turn = 0.4;
  }
  player.angle += turn * TURN_SPEED * dt;
  applyMovement(player, forward, strafe, dt, game.doorOpen);
}

function drawMouseSprite(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, hurt: number, dead: number) {
  ctx.save();
  ctx.translate(cx, cy);
  if (dead > 0) ctx.rotate(Math.PI / 2);
  const s = size;
  ctx.fillStyle = hurt > 0 ? "#fff" : "#8a8a92";
  ctx.beginPath();
  ctx.ellipse(0, s * 0.15, s * 0.32, s * 0.26, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#c96b7a";
  ctx.beginPath();
  ctx.ellipse(-s * 0.22, -s * 0.1, s * 0.11, s * 0.13, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(s * 0.22, -s * 0.1, s * 0.11, s * 0.13, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#2a2a2a";
  ctx.beginPath();
  ctx.moveTo(-s * 0.13, -s * 0.16);
  ctx.lineTo(-s * 0.2, -s * 0.4);
  ctx.lineTo(-s * 0.05, -s * 0.2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(s * 0.13, -s * 0.16);
  ctx.lineTo(s * 0.2, -s * 0.4);
  ctx.lineTo(s * 0.05, -s * 0.2);
  ctx.fill();
  if (dead <= 0) {
    ctx.fillStyle = "#ff2222";
    ctx.shadowColor = "#ff2222";
    ctx.shadowBlur = s * 0.15;
    ctx.beginPath();
    ctx.arc(-s * 0.1, s * 0.08, s * 0.045, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s * 0.1, s * 0.08, s * 0.045, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  } else {
    ctx.strokeStyle = "#000";
    ctx.lineWidth = Math.max(1, s * 0.02);
    ctx.beginPath();
    ctx.moveTo(-s * 0.14, s * 0.04);
    ctx.lineTo(-s * 0.04, s * 0.12);
    ctx.moveTo(-s * 0.04, s * 0.04);
    ctx.lineTo(-s * 0.14, s * 0.12);
    ctx.stroke();
  }
  ctx.fillStyle = "#4a2a2a";
  ctx.beginPath();
  ctx.arc(0, s * 0.2, s * 0.035, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

type PxRect = [x: number, y: number, w: number, h: number, color: string];
const ARM_FUR_DARK = "#19171c";
const ARM_FUR_MID = "#2c2831";
const ARM_FUR_LIGHT = "#3f3948";
const ARM_CLAW = "#f2ece0";
const ARM_CLAW_BASE = "#b9a98f";
// Cat forearm+paw, authored as flat axis-aligned rectangles rather than
// paths/arcs — canvas anti-aliases path fills (arc, lineTo, round line
// caps) regardless of imageSmoothingEnabled, which only governs drawImage
// scaling. That's why the previous stroke-based arm read as a blurry
// "stick" once scaled up: every edge was soft. Rects at integer grid
// coordinates are the only way to get genuinely crisp, non-anti-aliased
// pixel-art edges out of Canvas2D. Local sprite space: 16 units wide x 34
// tall, paw/claws at the top (y=0), shoulder at the bottom (y=34) — drawn
// once to an offscreen canvas (getArmSprite, below), then the CACHED
// bitmap is drawImage'd (smoothing off) wherever/however rotated it needs
// to appear each frame — rotating a pre-rendered crisp bitmap via nearest-
// neighbor gives a jagged-but-blocky look (not blurry), which reads as
// authentically retro rather than broken.
const ARM_SPRITE_W = 16;
const ARM_SPRITE_H = 34;
const ARM_SPRITE_RECTS: PxRect[] = [
  // forearm (bottom, near the shoulder — widest, tapering up toward the wrist)
  [2, 30, 12, 4, ARM_FUR_DARK],
  [3, 25, 10, 5, ARM_FUR_DARK],
  [4, 20, 8, 5, ARM_FUR_DARK],
  [4, 26, 2, 6, ARM_FUR_LIGHT],
  // wrist
  [5, 17, 6, 3, ARM_FUR_DARK],
  // paw pad
  [3, 15, 10, 2, ARM_FUR_MID],
  [2, 10, 12, 5, ARM_FUR_MID],
  [4, 8, 8, 2, ARM_FUR_MID],
  [5, 11, 3, 3, ARM_FUR_LIGHT],
  // claw-base shadow line where claws meet the pad
  [3, 9, 10, 1, ARM_CLAW_BASE],
  // four claws, fanned (outer two shorter)
  [1, 3, 2, 7, ARM_CLAW],
  [4, 0, 2, 10, ARM_CLAW],
  [9, 0, 2, 10, ARM_CLAW],
  [12, 3, 2, 7, ARM_CLAW],
];
let armSpriteCache: HTMLCanvasElement | null = null;
function getArmSprite(): HTMLCanvasElement {
  if (armSpriteCache) return armSpriteCache;
  const cell = 4; // px per grid unit in the cached bitmap
  const c = document.createElement("canvas");
  c.width = ARM_SPRITE_W * cell;
  c.height = ARM_SPRITE_H * cell;
  const sctx = c.getContext("2d");
  if (sctx) {
    for (const [x, y, w, h, color] of ARM_SPRITE_RECTS) {
      sctx.fillStyle = color;
      sctx.fillRect(x * cell, y * cell, w * cell, h * cell);
    }
  }
  armSpriteCache = c;
  return c;
}

// Held weapon sprites, also authored as neon-free crisp rect grids (see
// ARM sprite note above — the only way to avoid Canvas2D path anti-aliasing).
// Each is drawn once to an offscreen canvas, then drawImage'd with smoothing
// off. Coords are [x, y, w, h, color] in a small local grid (16 cols wide,
// ~20 tall), origin top-left; the sprite is anchored so its "grip" sits near
// the bottom-center of the screen. Scaling a crisp bitmap up with nearest-
// neighbor keeps a hard retro edge.
type Wpx = [x: number, y: number, w: number, h: number, color: string];
const W_CHEESE: Wpx[] = [
  // cheese-blast "stubby blaster" — a compact yellow gun, muzzle up.
  [5, 2, 6, 12, "#6f5a22"], // barrel (dark bronze)
  [6, 0, 4, 3, "#ffd54a"], // muzzle core
  [7, 0, 2, 1, "#fff3c0"], // hot muzzle glow
  [3, 12, 10, 5, "#f0c14b"], // body block
  [4, 13, 2, 1, "#fff0b0"], // body highlight
  [8, 14, 2, 2, "#caa23a"], // cheese hole 1
  [4, 10, 2, 2, "#caa23a"], // cheese hole 2
  [11, 11, 2, 2, "#caa23a"], // cheese hole 3
  [6, 17, 4, 3, "#5a4520"], // grip
  [7, 19, 2, 2, "#3c2f16"], // grip shadow
];
const W_TRAP: Wpx[] = [
  // mouse-trap launcher — a dark steel tube with a springy bail.
  [6, 2, 4, 13, "#6a6a72"], // tube
  [7, 0, 2, 2, "#989aa2"], // muzzle rim
  [6, 5, 4, 1, "#4a4a52"], // tube seam 1
  [6, 9, 4, 1, "#4a4a52"], // tube seam 2
  [2, 14, 12, 4, "#52525a"], // catch block / base
  [3, 15, 2, 1, "#77707a"], // highlight
  [1, 7, 3, 2, "#b9b9c2"], // bail (top loop)
  [1, 9, 1, 6, "#8a8a92"], // bail leg left
  [14, 9, 1, 6, "#8a8a92"], // bail leg right
  [13, 7, 3, 2, "#b9b9c2"], // bail top right
  [8, 18, 2, 2, "#3a3a42"], // trigger under grip
];
const weaponSpriteCache = new Map<"cheese" | "trap", HTMLCanvasElement>();
function getWeaponSprite(weapon: "cheese" | "trap"): HTMLCanvasElement {
  let cv = weaponSpriteCache.get(weapon);
  if (cv) return cv;
  const rects = weapon === "cheese" ? W_CHEESE : W_TRAP;
  const W = 16;
  const H = 22;
  const cell = 3; // px per unit in the cached bitmap
  cv = document.createElement("canvas");
  cv.width = W * cell;
  cv.height = H * cell;
  const sctx = cv.getContext("2d");
  if (sctx) {
    for (const [x, y, w, h, color] of rects) {
      sctx.fillStyle = color;
      sctx.fillRect(x * cell, y * cell, w * cell, h * cell);
    }
  }
  weaponSpriteCache.set(weapon, cv);
  return cv;
}

function drawWeaponView(ctx: CanvasRenderingContext2D, player: Player) {
  const bobY = Math.sin(player.bobT) * 2;
  const swipe = player.meleeSwipeT;
  const hurt = player.hurtFlash;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (player.weapon === "claws") {
    // A black cat forearm+paw pixel-art sprite (getArmSprite) swings in from
    // off-screen bottom-right and slashes across to upper-left as `swipe`
    // decays 1 (just fired) -> 0 (done) — empty-handed at rest, matching
    // "we should see the arm swing out" (not a weapon permanently held in
    // frame like the other two).
    if (swipe > 0.02) {
      const t = 1 - swipe; // 0 at the fire instant -> 1 as the slash completes
      const shoulderX = RES_W / 2 + 70;
      const shoulderY = RES_H + 14;
      const startA = -2.35;
      const endA = -0.55;
      const a = startA + (endA - startA) * Math.min(1, t * 1.5);
      const sprite = getArmSprite();
      const displayScale = 0.72;
      const dw = sprite.width * displayScale;
      const dh = sprite.height * displayScale;
      ctx.save();
      ctx.translate(shoulderX, shoulderY);
      ctx.rotate(a + Math.PI / 2);
      ctx.drawImage(sprite, -dw / 2, -dh, dw, dh);
      ctx.restore();
      if (swipe > 0.3) {
        ctx.strokeStyle = `rgba(255,255,255,${(swipe - 0.3) * 0.5})`;
        ctx.lineWidth = 2;
        for (const r of [22, 34, 46]) {
          ctx.beginPath();
          ctx.arc(shoulderX, shoulderY, r + dh * 0.6, a - 0.5, a + 0.1);
          ctx.stroke();
        }
      }
    }
    return;
  }

  // Cheese / trap: a proper held pixel-art weapon with a recoil kick that
  // pushes it down-screen on fire (`swipe` decays 1 -> 0), a subtle idle bob,
  // and a bright muzzle flash at the barrel tip while firing.
  const sprite = getWeaponSprite(player.weapon);
  const scale = 1.05;
  const dw = sprite.width * scale;
  const dh = sprite.height * scale;
  const kick = swipe * 14;
  const baseX = RES_W / 2 - dw / 2;
  const baseY = RES_H - dh + bobY + kick;
  // muzzle flash: a spiky star at the barrel top-center while briefly firing
  const muzzleT = player.weapon === "cheese" ? 0.35 : 0.55;
  if (swipe > 1 - muzzleT && hurt < 0.3) {
    const mx = RES_W / 2;
    const my = baseY - 2;
    const s = 6 + (1 - swipe) * 8;
    ctx.fillStyle = player.weapon === "cheese" ? "#ffe66a" : "#fff2c0";
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const r = i % 2 === 0 ? s : s * 0.45;
      const px = mx + Math.cos(ang) * r;
      const py = my + Math.sin(ang) * r * 0.8;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    // hot core
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(mx, my, s * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.drawImage(sprite, baseX, baseY, dw, dh);
  ctx.restore();
}

// ===========================================================================
// Procedural pixel-art textures, built once into offscreen canvases. Each is
// 16px wide so the raycast samples a 1px source strip and stretches it to the
// column's wall height with nearest-neighbor (imageSmoothingEnabled=false) —
// the crisp, chunky 1993 look, not blurred upscaling. Keyed by DoomWallTex.
// ===========================================================================
const TEX_WALL_PX = 16;
const texCache = new Map<DoomWallTex, HTMLCanvasElement>();
// Packed ABGR pixels for each texture (little-endian Uint32 = 0xAABBGGRR),
// read once from the canvas so the per-pixel wall pass can sample directly.
const texPixCache = new Map<DoomWallTex, Uint32Array>();
function getTexPixels(kind: DoomWallTex): Uint32Array {
  let out = texPixCache.get(kind);
  if (out) return out;
  const src = getTex(kind);
  const cx = src.getContext("2d");
  out = new Uint32Array(16 * 16);
  if (cx) {
    const im = cx.getImageData(0, 0, 16, 16);
    for (let i = 0; i < 16 * 16; i++) {
      const j = i * 4;
      out[i] = (im.data[j + 3] << 24) | (im.data[j + 2] << 16) | (im.data[j + 1] << 8) | im.data[j];
    }
  }
  texPixCache.set(kind, out);
  return out;
}

// Offscreen scene framebuffer 0xAABBGGRR. The 3D scene (floor/ceiling/walls)
// is rasterized here each frame, then putImageData'd onto the visible canvas;
// sprites/weapon/crosshair are painted on top with normal canvas ops, so the
// low-res pixel look is preserved without any per-column drawImage smearing.
let fbImage: ImageData | null = null;
let fb32: Uint32Array | null = null;
function ensureFb() {
  if (!fbImage) {
    fbImage = new ImageData(RES_W, RES_H);
    fb32 = new Uint32Array(fbImage.data.buffer);
  }
  return fb32!;
}
// Write one scene pixel; `f` (0..1) scales the texture/color for side+distance
// shading. Mutates the shared framebuffer.
function fbPx(col: number, y: number, c: number, f: number) {
  if (col < 0 || y < 0 || col >= RES_W || y >= RES_H) return;
  const r = Math.min(255, ((c & 255) * f) | 0);
  const g = Math.min(255, (((c >>> 8) & 255) * f) | 0);
  const b = Math.min(255, (((c >>> 16) & 255) * f) | 0);
  fb32![y * RES_W + col] = (255 << 24) | (b << 16) | (g << 8) | r;
}
// Solid-color scene pixel (ceil/floor/sky), scaled by f.
function fbSolid(col: number, y: number, r: number, g: number, b: number, f: number) {
  if (col < 0 || y < 0 || col >= RES_W || y >= RES_H) return;
  fb32![y * RES_W + col] = (255 << 24) | ((Math.min(255, (b * f) | 0)) << 16) | ((Math.min(255, (g * f) | 0)) << 8) | Math.min(255, (r * f) | 0);
}
function texColor(base: [number, number, number], n: number): [number, number, number] {
  return [(base[0] * n) | 0, (base[1] * n) | 0, (base[2] * n) | 0];
}
function buildTex(kind: DoomWallTex): HTMLCanvasElement {
  // Each painter writes into a 16x16 (r,c) grid. Values 0..255 are quantized
  // shades of a base palette so up-close walls read as textured surfaces, not
  // noise. Deliberately dull/dark — DOOM's palette is murky, not saturated.
  const S = TEX_WALL_PX;
  const grid: [number, number, number][][] = [];
  for (let r = 0; r < S; r++) {
    grid.push([]);
    for (let c = 0; c < S; c++) grid[r].push([0, 0, 0]);
  }
  const put = (r: number, c: number, col: [number, number, number]) => {
    if (r >= 0 && r < S && c >= 0 && c < S) grid[r][c] = col;
  };
  const fill = (r0: number, c0: number, r1: number, c1: number, col: [number, number, number]) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) put(r, c, col);
  };

  if (kind === "tech") {
    // Hangar: grey-green metal panels. A bold dark seam at the tile's left edge
    // makes each 1-tile repeat read as a distinct panel, giving the wall visible
    // scale (you can count panels to gauge position/distance).
    const panel = texColor([168, 172, 180], 1);
    const panelDark = texColor([168, 172, 180], 0.72);
    const rivet = texColor([222, 228, 238], 1);
    const seam = texColor([58, 62, 70], 1);
    fill(0, 0, 15, 15, panel);
    fill(0, 0, 15, 1, seam); // strong tile-edge seam
    fill(0, 7, 15, 8, seam);
    // subtle shading blocks, not large dark areas
    fill(5, 3, 9, 6, panelDark);
    fill(2, 10, 5, 15, panelDark);
    // rivets in corners of each half
    for (const [r, c] of [[1, 1], [1, 14], [14, 1], [14, 14], [7, 1], [7, 14], [2, 1], [2, 14]]) put(r, c, rivet);
    // vent slats on left half
    for (let i = 0; i < 5; i++) fill(2 + i * 2, 2, 2 + i * 2, 5, seam);
  } else if (kind === "brick") {
    // Hall/corridor: irregular dark-red bricks with mortar.
    const mortar = texColor([54, 46, 44], 1);
    const brickA = texColor([176, 84, 66], 1);
    const brickB = texColor([146, 70, 60], 1);
    const brickC = texColor([126, 62, 54], 1);
    fill(0, 0, 15, 15, mortar);
    for (let r = 0; r < 16; r += 4) {
      const c0 = (r / 4) % 2 === 0 ? 0 : 4;
      for (let c = c0 - 1; c < 16; c += 4) {
        // mortar at brick borders: fill row r (1px), col c, and centers
        fill(r, c < 0 ? 0 : c, r, Math.min(15, c + 3), (r + c) % 3 === 0 ? brickA : (r + c) % 3 === 1 ? brickB : brickC);
      }
      if (r + 1 < 16) fill(r + 1, 0, r + 1, 15, mortar);
    }
  } else if (kind === "metal") {
    // Courtyard: darker sci-fi wall, vertical ribs + a hazard chevron band.
    const base = texColor([118, 122, 128], 1);
    const rib = texColor([158, 164, 172], 1);
    const dark = texColor([66, 70, 74], 1);
    const hzY = texColor([198, 54, 28], 1);
    const hzW = texColor([226, 222, 206], 1);
    fill(0, 0, 15, 15, base);
    for (let c = 0; c < 16; c += 4) fill(0, c, 15, c, rib);
    for (let c = 2; c < 16; c += 4) fill(0, c, 15, c, dark);
    // hazard band row 7-9
    for (let r = 7; r <= 9; r++) for (let c = 0; c < 16; c++) put(r, c, (r + c) % 2 === 0 ? hzY : hzW);
  } else if (kind === "door") {
    // Exit room door jamb: metal door with a small glass slit + handle.
    const door = texColor([142, 136, 130], 1);
    const frame = texColor([88, 82, 76], 1);
    const slit = texColor([150, 188, 232], 1);
    const edge = texColor([52, 48, 44], 1);
    fill(0, 0, 15, 15, door);
    fill(0, 0, 15, 0, frame);
    fill(0, 15, 15, 15, frame);
    fill(0, 0, 0, 15, frame);
    fill(15, 0, 15, 15, frame);
    // horizontal panel seams
    for (let r = 4; r < 16; r += 4) fill(r, 1, r, 14, edge);
    // glass slit
    for (let r = 5; r <= 8; r++) for (let c = 3; c <= 7; c++) put(r, c, slit);
    // handle
    for (let r = 9; r <= 11; r++) put(r, 12, texColor([210, 200, 180], 1));
  } else if (kind === "exit") {
    // Exit switch: dark wall with a glowing green "EXIT" sign.
    const wall = texColor([86, 82, 76], 1);
    const glow = texColor([110, 246, 120], 1);
    const lit = texColor([170, 255, 180], 1);
    const darker = texColor([50, 50, 46], 1);
    fill(0, 0, 15, 15, wall);
    // sign plate
    fill(3, 2, 12, 13, texColor([16, 16, 16], 1));
    // faux pixel "EXIT" glyphs as lit blocks
    for (let r = 6; r <= 9; r++) for (let c = 3; c <= 12; c++) put(r, c, (r + c) % 5 < 3 ? lit : glow);
    // hazard stripes top/bottom
    for (let r = 0; r <= 1; r++) for (let c = 0; c < 16; c++) put(r, c, c % 2 === 0 ? texColor([120, 120, 120], 1) : darker);
    for (let r = 14; r <= 15; r++) for (let c = 0; c < 16; c++) put(r, c, c % 2 === 0 ? texColor([120, 120, 120], 1) : darker);
  } else {
    // "window" / default: cement sill & header block with a beaded edge.
    const cement = texColor([176, 170, 160], 1);
    const bead = texColor([214, 210, 200], 1);
    const shade = texColor([134, 128, 118], 1);
    fill(0, 0, 15, 15, cement);
    for (let c = 0; c < 16; c++) put(0, c, bead);
    for (let c = 0; c < 16; c++) put(15, c, shade);
    for (let r = 0; r < 16; r++) put(r, 0, bead);
    for (let r = 0; r < 16; r++) put(r, 15, shade);
  }

  const cv = document.createElement("canvas");
  cv.width = S;
  cv.height = S;
  const cx = cv.getContext("2d");
  if (cx) {
    const im = cx.createImageData(S, S);
    for (let r = 0; r < S; r++) {
      for (let c = 0; c < S; c++) {
        const [R, G, B] = grid[r][c];
        const idx = (r * S + c) * 4;
        im.data[idx] = R;
        im.data[idx + 1] = G;
        im.data[idx + 2] = B;
        im.data[idx + 3] = 255;
      }
    }
    cx.putImageData(im, 0, 0);
  }
  return cv;
}
function getTex(kind: DoomWallTex): HTMLCanvasElement {
  let cv = texCache.get(kind);
  if (!cv) {
    cv = buildTex(kind);
    texCache.set(kind, cv);
  }
  return cv;
}

// (side shading now happens per-pixel during the wall pass via `sideC`, so
// no pre-tinted texture variants are needed.)

// Faux exterior for windows: a distant sky with a low sun and a layered
// mountain silhouette, driven by the ray's world angle so panning the view
// sweeps the scenery past the pane (parallax that sells "out there").
function skyColumn(angle: number): { sky: [number, number, number]; sun: [number, number, number]; mountain: [number, number, number] } {
  const day = (Math.sin(angle) + 1) / 2; // 0..1 across the sweep
  const horizon = texColor([150, 78, 70], 1);
  const zenith = texColor([78, 52, 92], 1);
  const sun = texColor([255, 206, 120], 1);
  const mtn = texColor([44, 34, 40], 1);
  // gradient zenith -> horizon as angle-dependent blend; the sun sits at a
  // fixed "world azimuth" (angle 0.9) and fades out away from it.
  const t = Math.max(0, Math.min(1, day * 0.6 + 0.2));
  const skyR = (zenith[0] + (horizon[0] - zenith[0]) * t) | 0;
  const skyG = (zenith[1] + (horizon[1] - zenith[1]) * t) | 0;
  const skyB = (zenith[2] + (horizon[2] - zenith[2]) * t) | 0;
  return { sky: [skyR, skyG, skyB], sun, mountain: mtn };
}

// Rasterize a wall column strip between two screen rows (`rowA`,`rowB` — order
// doesn't matter; they're normalized), sampling the texture column at `wallU`
// (the absolute coordinate along the wall face, in world units) so the texture
// repeats once per tile — giving the wall visible scale so you can judge where
// you are. `side` darkens the perpendicular face, `perp` darkens with distance.
// Writes straight into the shared framebuffer (no drawImage stretch/compositing),
// which is what eliminated the edge smearing.
function drawWallStrip(
  col: number,
  tex: DoomWallTex,
  rowA: number,
  rowB: number,
  perp: number,
  wallU: number,
  side: 0 | 1,
) {
  const top = Math.max(0, Math.round(Math.min(rowA, rowB)));
  const bot = Math.min(RES_H, Math.round(Math.max(rowA, rowB)));
  if (bot <= top) return;
  const h = bot - top;
  const px = getTexPixels(tex);
  // Repeat the 16px texture every 1 world tile so a long wall shows many panels.
  const sx = Math.max(0, Math.min(TEX_WALL_PX - 1, Math.floor(wallU * TEX_WALL_PX) & (TEX_WALL_PX - 1)));
  const shade = Math.max(0.62, 1 - perp / 20) * (side === 1 ? 0.85 : 1);
  for (let y = top; y < bot; y++) {
    const v = Math.max(0, Math.min(TEX_WALL_PX - 1, Math.floor(((y - top) / h) * TEX_WALL_PX)));
    fbPx(col, y, px[v * TEX_WALL_PX + sx], shade);
  }
}

// Fill the window's see-through band with exterior: a distant sky + a low sun
// + a mountain ridge, blended over the sky gradient by screen row so it looks
// like peering out at a horizon rather than a flat pasted rectangle.
function drawSkyGap(col: number, rowTop: number, rowBot: number, angle: number) {
  const top = Math.max(0, Math.round(rowTop));
  const bot = Math.min(RES_H, Math.round(rowBot));
  if (bot <= top) return;
  const { sky, sun, mountain } = skyColumn(angle);
  for (let y = top; y < bot; y++) {
    const t = (y - top) / Math.max(1, bot - top);
    const f = 0.75 + t * 0.35;
    fbSolid(col, y, sky[0], sky[1], sky[2], f);
    // mountain ridge sits in the lower third of the pane
    if (t > 0.68) {
      const ridge = 0.68 + 0.27 * Math.abs(Math.sin(angle * 3.7 + col * 0.05));
      if (t < ridge) fbSolid(col, y, mountain[0], mountain[1], mountain[2], 1);
    }
    // low sun: warm blob drifting across with view angle, in the upper half
    const sunFrac = 1 - Math.abs(((angle * 0.9) % (Math.PI * 2)) - 0.9) / 0.8;
    if (sunFrac > 0.5 && t < 0.5) {
      const glow = Math.max(0, (sunFrac - 0.5) * 2) * (1 - t * 2);
      fbSolid(col, y, sun[0], sun[1], sun[2], f * glow);
    }
  }
}

// ===========================================================================
// Full textured render. Uses a single projection: for a ray at perpendicular
// distance `perp`, a world height `h` (with the eye at posZ=0.5 and the wall
// spanning floor 0..ceiling ceilH) maps to screen row
//   y(x) = centerY - (h - 0.5) * RES_H / perp
// so a ceiling at 1.0 is a full screen; a lower per-room ceiling (e.g. 0.7)
// visibly lowers the wall top — the "different ceiling geometry between rooms".
// ===========================================================================
const POS_Z = 0.5;
const CENTER_Y = RES_H / 2;

function render(ctx: CanvasRenderingContext2D, game: GameState) {
  const { player } = game;
  const doorOpen = game.doorOpen;
  const fb = ensureFb();
  fb.fill(0);

  // Camera plane: perpendicular to facing, length tan(FOV/2). A column's ray is
  // dir + plane*cameraX; the DDA on that UN-normalized vector yields a true
  // perpendicular distance (no fish-eye), so walls are straight, not bowed.
  const dirX = Math.cos(player.angle);
  const dirY = Math.sin(player.angle);
  const planeLen = Math.tan(FOV / 2);
  const planeX = -dirY * planeLen;
  const planeY = dirX * planeLen;
  const leftX = dirX - planeX;
  const leftY = dirY - planeY;
  const stepX = ((dirX + planeX) - leftX) / RES_W;
  const stepY = ((dirY + planeY) - leftY) / RES_W;

  // Per-column geometry captured once in pass 1 (shared by floor/ceiling + walls).
  const yTopC = new Array<number>(RES_W);
  const yBotC = new Array<number>(RES_W);
  const roomC = new Array<DoomRoom>(RES_W);
  const cellC = new Array<DoomCell | null>(RES_W);
  const wallUC = new Array<number>(RES_W);
  const sideC = new Array<0 | 1>(RES_W);

  for (let col = 0; col < RES_W; col++) {
    const cameraX = (2 * col) / RES_W - 1;
    const rdx = dirX + planeX * cameraX;
    const rdy = dirY + planeY * cameraX;
    const hit = castRay(player.x, player.y, rdx, rdy, doorOpen);
    const perp = Math.max(0.0001, hit.perpDist);
    game.zbuffer[col] = perp;
    const nr = hit.nearRoom;
    roomC[col] = nr;
    yTopC[col] = Math.max(0, Math.min(RES_H, CENTER_Y - (nr.ceilH - POS_Z) * (RES_H / perp)));
    yBotC[col] = Math.max(0, Math.min(RES_H, CENTER_Y + (POS_Z - nr.floorH) * (RES_H / perp)));
    cellC[col] = hit.cell;
    wallUC[col] = hit.wallU;
    sideC[col] = hit.side;
  }

  // Pass 2: perspective floor & ceiling casting. Rows below the horizon sample
  // the receding world floor, rows above sample the ceiling — this is what makes
  // the space read as navigable. Pixels covered by a wall are left for pass 3.
  for (let y = 0; y < RES_H; y++) {
    if (y === CENTER_Y) continue;
    const isFloor = y > CENTER_Y;
    const pRow = isFloor ? y - CENTER_Y : CENTER_Y - y;
    const rowDist = (POS_Z * RES_H) / pRow;
    let fX = player.x + leftX * rowDist;
    let fY = player.y + leftY * rowDist;
    const sx = stepX * rowDist;
    const sy = stepY * rowDist;
    for (let x = 0; x < RES_W; x++) {
      if (y >= yTopC[x] && y < yBotC[x]) { fX += sx; fY += sy; continue; }
      const perp = game.zbuffer[x];
      if (rowDist > perp + 0.8) { fX += sx; fY += sy; continue; }
      const cell = cellAt(Math.floor(fY), Math.floor(fX));
      const room = roomOfCell(cell);
      const base = isFloor ? room.floorColor : room.ceilColor;
      const ds = Math.max(0.4, 1 - rowDist / (isFloor ? 18 : 16));
      // subtle world-space checker so the receding surface reads (not a flat band)
      const chk = ((Math.floor(fX * 2) + Math.floor(fY * 2)) & 1) ? 1 : 0.82;
      fbSolid(x, y, base[0], base[1], base[2], ds * chk);
      fX += sx; fY += sy;
    }
  }

  // Pass 3: textured walls painted over the floor/ceiling.
  for (let col = 0; col < RES_W; col++) {
    const cameraX = (2 * col) / RES_W - 1;
    const rdx = dirX + planeX * cameraX;
    const rdy = dirY + planeY * cameraX;
    const hit = castRay(player.x, player.y, rdx, rdy, doorOpen);
    const perp = Math.max(0.0001, hit.perpDist);
    const yTop = yTopC[col];
    const yBot = yBotC[col];
    const cell = cellC[col];

    let texKind: DoomWallTex = roomC[col].wallTex;
    if (cell?.type === "window") {
      const sillH = 0.22;
      const headerH = 0.7;
      const sillTopY = Math.max(0, Math.min(RES_H, CENTER_Y - (sillH - POS_Z) * (RES_H / perp)));
      const headerBotY = Math.max(0, Math.min(RES_H, CENTER_Y - (headerH - POS_Z) * (RES_H / perp)));
      texKind = roomC[col].frameTex;
      drawWallStrip(col, texKind, headerBotY, yTop, perp, wallUC[col], sideC[col]);
      drawWallStrip(col, texKind, yBot, sillTopY, perp, wallUC[col], sideC[col]);
      drawSkyGap(col, sillTopY, headerBotY, player.angle - FOV / 2 + (col / RES_W) * FOV);
    } else if (cell?.type === "door") {
      texKind = "door";
      const panelBotY = Math.max(0, Math.min(RES_H, CENTER_Y - (doorOpen - POS_Z) * (RES_H / perp)));
      drawWallStrip(col, texKind, panelBotY, yTop, perp, wallUC[col], sideC[col]);
      // darken the open floor gap under the raised panel
      const rowL = Math.min(RES_H, Math.round(panelBotY));
      const rowB = Math.round(yBot);
      for (let y2 = rowL; y2 < rowB; y2++) fbSolid(col, y2, 20, 14, 10, 1);
    } else if (cell?.type === "exit") {
      texKind = "exit";
      drawWallStrip(col, texKind, yBot, yTop, perp, wallUC[col], sideC[col]);
    } else {
      if (!cell) texKind = "brick";
      drawWallStrip(col, texKind, yBot, yTop, perp, wallUC[col], sideC[col]);
    }
  }

  // Blit the scene framebuffer, then sprites/weapon draw on top.
  ctx.putImageData(fbImage!, 0, 0);

type Billboard = { x: number; y: number; dist: number; draw: () => void };
  const boards: Billboard[] = [];
  // Floor line (screen row where z=0 sits) at a given perpendicular distance.
  const floorY = (perp: number) => Math.min(RES_H, CENTER_Y + POS_Z * (RES_H / perp));
  for (const m of game.mice) {
    if (!m.alive && m.deathT > 1.2) continue;
    const dx = m.x - player.x;
    const dy = m.y - player.y;
    const dist = Math.hypot(dx, dy);
    const rel = normalizeAngle(Math.atan2(dy, dx) - player.angle);
    if (Math.abs(rel) > FOV / 2 + 0.3 || dist < 0.15) continue;
    const screenX = (0.5 + rel / FOV) * RES_W;
    const col = Math.max(0, Math.min(RES_W - 1, Math.round(screenX)));
    const perp = Math.max(0.001, dist * Math.cos(rel));
    if (perp > game.zbuffer[col] + 0.15) continue;
    const size = Math.min(RES_H * 1.6, (RES_H / perp) * 0.62);
    // Feet sit on the floor line; the sprite is a roughly-square billboard.
    const cy = floorY(perp) - size / 2;
    boards.push({ x: screenX, y: cy, dist: perp, draw: () => drawMouseSprite(ctx, screenX, cy, size, m.hurtT, m.alive ? 0 : Math.min(1, m.deathT * 2)) });
  }
  for (const p of game.projectiles) {
    const dx = p.x - player.x;
    const dy = p.y - player.y;
    const dist = Math.hypot(dx, dy);
    const rel = normalizeAngle(Math.atan2(dy, dx) - player.angle);
    if (Math.abs(rel) > FOV / 2 + 0.3 || dist < 0.1) continue;
    const screenX = (0.5 + rel / FOV) * RES_W;
    const col = Math.max(0, Math.min(RES_W - 1, Math.round(screenX)));
    const perp = Math.max(0.001, dist * Math.cos(rel));
    if (perp > game.zbuffer[col] + 0.1) continue;
    const size = Math.min(RES_H, (RES_H / perp) * 0.16);
    // Projectiles fly at roughly chest height (a bit above the floor line).
    const cy = floorY(perp) - size * 0.35;
    boards.push({
      x: screenX,
      y: cy,
      dist: perp,
      draw: () => {
        ctx.save();
        ctx.translate(screenX, cy);
        if (p.kind === "cheese") {
          ctx.fillStyle = "#f0c14b";
          ctx.beginPath();
          ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#caa23a";
          ctx.beginPath();
          ctx.arc(-size * 0.15, -size * 0.1, size * 0.1, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = "#888";
          ctx.fillRect(-size / 2, -size / 3, size, size * 0.66);
        }
        ctx.restore();
      },
    });
  }
  for (const sp of game.sparks) {
    if (sp.life <= 0) continue;
    const dx = sp.x - player.x;
    const dy = sp.y - player.y;
    const dist = Math.hypot(dx, dy);
    const rel = normalizeAngle(Math.atan2(dy, dx) - player.angle);
    if (Math.abs(rel) > FOV / 2 + 0.3 || dist < 0.1) continue;
    const screenX = (0.5 + rel / FOV) * RES_W;
    const perp = Math.max(0.001, dist * Math.cos(rel));
    const size = Math.min(RES_H, (RES_H / perp) * 0.2);
    const cy = floorY(perp) - size * 0.2;
    boards.push({
      x: screenX,
      y: cy,
      dist: perp - 0.05,
      draw: () => {
        ctx.save();
        ctx.globalAlpha = Math.max(0, sp.life / 0.25);
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(screenX, cy, size / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      },
    });
  }
  boards.sort((a, b) => b.dist - a.dist);
  for (const b of boards) b.draw();

  drawWeaponView(ctx, player);

  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(RES_W / 2 - 4, RES_H / 2);
  ctx.lineTo(RES_W / 2 + 4, RES_H / 2);
  ctx.moveTo(RES_W / 2, RES_H / 2 - 4);
  ctx.lineTo(RES_W / 2, RES_H / 2 + 4);
  ctx.stroke();

  if (player.hurtFlash > 0) {
    ctx.fillStyle = `rgba(180,0,0,${player.hurtFlash * 0.45})`;
    ctx.fillRect(0, 0, RES_W, RES_H);
  }
}

interface Hud {
  health: number;
  armor: number;
  weapon: DoomWeapon;
  ammoCheese: number;
  ammoTrap: number;
  kills: number;
  mode: Mode;
  taunt: string;
  hint: string;
  message: string; // transient status-bar message (pickups / door / exit)
}

// One Doom-style status-bar readout: a big red number (vanilla Doom's
// AMMO/HEALTH/ARMOR digits are all the same red — not color-coded per stat,
// confirmed against the Doom Wiki/source rather than guessed) over a small
// tracked-out yellow label. The real status bar has no such text labels
// (players just learn ammo-far-left/health-center/armor-far-right by
// position) — kept here anyway since this HUD doesn't have decades of
// player conditioning behind it, but in vanilla's yellow, not an invented
// color. Custom pixel typeface we don't have, so bold tabular-nums + a
// matching glow stands in for it.
const DOOM_RED = "#e0201a";
const DOOM_YELLOW = "#e8c02a";
function DoomStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex flex-col items-center leading-none">
      <span
        className="text-xl sm:text-2xl font-extrabold tabular-nums"
        style={{ color: DOOM_RED, textShadow: `0 0 6px ${DOOM_RED}88` }}
      >
        {value}
      </span>
      <span className="text-[8px] tracking-[0.25em] mt-0.5" style={{ color: DOOM_YELLOW }}>
        {label}
      </span>
    </div>
  );
}

export function DoomOverlay({
  presenter,
  onFinished,
  headerH,
}: {
  presenter: UsePresenter;
  onFinished: () => void;
  /** Flow's HEADER_H — the quit button and hint chip sit just below the
   *  app header (z-40) rather than at the raw viewport corner, or the
   *  header's own Settings gear (same corner) would sit on top of them and
   *  eat the click (confirmed live: tapping "quit" opened Settings instead). */
  headerH: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gameRef = useRef<GameState>(freshGame());
  const presenterRef = useRef(presenter);
  presenterRef.current = presenter;
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const endedRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [hud, setHud] = useState<Hud>({
    health: 100,
    armor: DOOM_START_ARMOR,
    weapon: "claws",
    ammoCheese: 8,
    ammoTrap: 3,
    kills: 0,
    mode: "wait",
    taunt: "",
    hint: "Arrows turn · A/D strafe · SPACE fire — autoplay in 4s",
    message: "",
  });

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.imageSmoothingEnabled = false;

    // No portrait canvas here: two independent attempts at pixelating
    // Luna's own live rendering both hit hard platform walls. (1) Reading
    // her <sv-presenter> canvas — same-origin, confirmed reachable — came
    // back blank regardless of read timing, including reading via the
    // iframe's own requestAnimationFrame (same per-frame batch as Cocos's
    // draw call, before compositing/clear — the textbook fix for WebGL's
    // preserveDrawingBuffer:false, and it still didn't help). (2) Separately
    // and more fundamentally: nothing drawn in front of her actually paints
    // on top of her — confirmed directly by forcing an opaque lime/magenta
    // background (bypassing all drawing logic) onto a covering div/canvas at
    // her exact rect+z-index, with `isolation:isolate` and
    // `transform:translateZ(0)` GPU-layer-promotion hints, and her real
    // rendering still showed through unchanged. Her element appears to
    // composite via a layer that bypasses normal DOM stacking for paint
    // (though not for hit-testing — elementFromPoint correctly reported the
    // covering element as topmost). Given neither reading nor covering her
    // works, we keep her real element visible/live here (user direction:
    // preserve her actual reactions/lip-sync over literal pixelation) — see
    // the "doom" filter case in App.tsx's stageView for the only thing that
    // *is* safe to do to her directly (a CSS filter, not an overlay).
    let ac: AudioContext | null = null;
    try {
      ac = new AudioContext();
      audioCtxRef.current = ac;
    } catch {
      // Sound is a nicety, not required — keep playing silently if unavailable.
    }
    const sfx = (kind: "shoot" | "melee" | "hit" | "kill") => {
      if (!ac) return;
      try {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        const now = ac.currentTime;
        const freq = kind === "shoot" ? 520 : kind === "melee" ? 220 : kind === "hit" ? 340 : 700;
        osc.type = kind === "melee" ? "sawtooth" : "square";
        osc.frequency.setValueAtTime(freq, now);
        osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq * (kind === "kill" ? 0.3 : 0.6)), now + 0.12);
        gain.gain.setValueAtTime(0.11, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
        osc.connect(gain).connect(ac.destination);
        osc.start(now);
        osc.stop(now + 0.15);
      } catch {
        // Best-effort blips only.
      }
    };

    const game = gameRef.current;
    let mounted = true;

    // Every taunt line, prerendered (homelab TTS + pitch-preserving speed-up,
    // see synthesizeExcitedVoice) as soon as the egg mounts — fire-and-forget,
    // gameplay never waits on this. The function itself caches per (voice,
    // speed, text), so this just warms that cache before it's needed; a
    // trigger that fires before its line is ready still works, it just pays
    // the TTS round-trip that one time instead of hitting the cache.
    void Promise.all(
      [...DOOM_TAUNTS_START, ...DOOM_TAUNTS_KILL, ...DOOM_TAUNTS_HURT, ...DOOM_TAUNTS_IDLE, ...DOOM_TAUNTS_VICTORY, ...DOOM_TAUNTS_DEATH].map(
        (line) => synthesizeExcitedVoice(line, DOOM_TAUNT_VOICE, DOOM_TAUNT_SPEED).catch(() => {}),
      ),
    );
    // Plays `text` through Luna's avatar using the prerendered/sped-up clip
    // (presenter.speakAudio — her mouth still animates off the audio, same as
    // the codec/AYB eggs' own baked clips) rather than presenter.speakText's
    // live native-voice pipeline, which can't be prerendered or time-
    // stretched ourselves.
    const speakExcited = async (text: string): Promise<void> => {
      try {
        const { audio } = await synthesizeExcitedVoice(text, DOOM_TAUNT_VOICE, DOOM_TAUNT_SPEED);
        await presenterRef.current.speakAudio(audio, text);
      } catch {
        // Missing/failed TTS still lets the beat land, just silently.
      }
    };
    const speak = (text: string) => {
      if (game.taunting) return;
      game.taunting = true;
      setHud((h) => ({ ...h, taunt: text }));
      void speakExcited(text).finally(() => {
        game.taunting = false;
      });
      window.setTimeout(() => {
        if (!mounted) return;
        setHud((h) => (h.taunt === text ? { ...h, taunt: "" } : h));
      }, 2600);
    };
    // Transient bottom-bar message: a pickup/pickup-style "WOULD YOU LIKE TO
    // SAVE"/"EXIT" readout, shown briefly then fades (mirrors vanilla's
    // message bar). Message text is a plain string; countdown in the loop.
    const showMessage = (text: string) => {
      game.messageT = 4.2;
      setHud((h) => ({ ...h, message: text }));
    };
    // Single funnel for every kill (melee's instant hit-check and the
    // projectile loop below both route here) so the "kill" blip and Luna's
    // kill taunt never depend on which weapon landed the blow.
    const onMouseKilled = () => {
      sfx("kill");
      speak(pickDoomTaunt(DOOM_TAUNTS_KILL));
    };

    const finish = () => {
      if (endedRef.current) return;
      endedRef.current = true;
      onFinishedRef.current();
    };

    const endGame = (reason: "demo-end" | "death" | "victory" | "quit") => {
      if (game.mode === "ending") return;
      game.mode = "ending";
      setHud((h) => ({ ...h, mode: "ending" }));
      const text = reason === "death" ? pickDoomTaunt(DOOM_TAUNTS_DEATH) : reason === "victory" ? pickDoomTaunt(DOOM_TAUNTS_VICTORY) : null;
      if (text && !game.taunting) {
        game.taunting = true;
        void speakExcited(text).finally(finish);
      } else {
        window.setTimeout(finish, reason === "quit" ? 0 : 300);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === "Escape" || k === "x" || k === "X") {
        e.preventDefault();
        endGame("quit");
        return;
      }
  const controlKeys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d", "q", "e", "W", "A", "S", "D", "Q", "E", " ", "1", "2", "3"];
  if (!controlKeys.includes(k)) return;
  e.preventDefault();
  if (game.mode === "wait" || game.mode === "demo") {
    // Only announce "start" here if the demo never got the chance to
    // (player grabbed control inside the first 4s) — interrupting an
    // already-announced demo shouldn't repeat the same line.
    const wasWaiting = game.mode === "wait";
    game.mode = "live";
    game.modeT = 0;
    setHud((h) => ({ ...h, mode: "live", hint: "" }));
    if (wasWaiting) speak(pickDoomTaunt(DOOM_TAUNTS_START));
  }
  if (game.mode !== "live") return;
  const nk = k.length === 1 ? k.toLowerCase() : k;
  if (["arrowup", "arrowdown", "arrowleft", "arrowright"].includes(nk.toLowerCase()) || ["w", "a", "s", "d", "q", "e"].includes(nk)) {
    game.keys.add(nk);
  } else if (k === " ") {
        if (!e.repeat) fireWeapon(game, sfx, onMouseKilled);
      } else if (k === "1") {
        game.player.weapon = "claws";
        setHud((h) => ({ ...h, weapon: "claws" }));
      } else if (k === "2") {
        game.player.weapon = "cheese";
        setHud((h) => ({ ...h, weapon: "cheese" }));
      } else if (k === "3") {
        game.player.weapon = "trap";
        setHud((h) => ({ ...h, weapon: "trap" }));
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key;
      const nk = k.length === 1 ? k.toLowerCase() : k;
      game.keys.delete(nk);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    let rafId = 0;
    let lastT = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(0.05, (t - lastT) / 1000);
      lastT = t;
      const { player } = game;

      if (game.mode === "wait") {
        game.modeT += dt;
        if (game.modeT >= DOOM_IDLE_TRIGGER_MS / 1000) {
          game.mode = "demo";
          game.modeT = 0;
          setHud((h) => ({ ...h, mode: "demo", hint: "DEMO — Luna's on autopilot" }));
          speak(pickDoomTaunt(DOOM_TAUNTS_START));
        }
      } else if (game.mode === "demo") {
        game.modeT += dt;
        autopilotStep(game, dt, sfx, onMouseKilled);
        if (game.modeT >= DOOM_DEMO_MS / 1000) {
          endGame("demo-end");
        }
  } else if (game.mode === "live") {
    const k = game.keys;
    const forward = (k.has("ArrowUp") || k.has("w") ? 1 : 0) - (k.has("ArrowDown") || k.has("s") ? 1 : 0);
    // Arrows turn; A/D and Q/E strafe sideways instead of also turning (the
    // modern FPS split — WASD/QE moves relative to facing, arrows look
    // around) rather doubling up on the same keys.
    const turn = k.has("ArrowRight") ? 1 : k.has("ArrowLeft") ? -1 : 0;
    const strafe = (k.has("d") ? 1 : 0) - (k.has("a") ? 1 : 0) + (k.has("e") ? 1 : 0) - (k.has("q") ? 1 : 0);
    player.angle += turn * TURN_SPEED * dt;
    applyMovement(player, forward, strafe, dt, game.doorOpen);
    player.bobT += forward !== 0 || strafe !== 0 ? dt * 9 : dt * 2;
    game.idleTauntT -= dt;
    if (game.idleTauntT <= 0) {
      game.idleTauntT = 5 + Math.random() * 3;
      if (!game.taunting && Math.random() < 0.6) speak(pickDoomTaunt(DOOM_TAUNTS_IDLE));
    }
  }

  // Door: auto-opens when the player (or an approaching path) gets close, and
  // holds open while the player is standing in or right at the doorway; it
  // re-lower when they back off. The full-open threshold matches cellSolid.
  const doorTile = {x: 11, y: 3};
  const doorDist = Math.hypot(player.x - (doorTile.x + 0.5), player.y - (doorTile.y + 0.5));
  const wantOpen = doorDist < 1.6 || (game.doorTouching && doorDist < 2.4);
  game.doorTouching = doorDist < 1.6;
  const wasOpen = game.doorOpen > 0.5;
  if (wantOpen) game.doorOpen = Math.min(1, game.doorOpen + dt * 1.6);
  else game.doorOpen = Math.max(0, game.doorOpen - dt * 0.9);
  if (!wasOpen && game.doorOpen > 0.5) showMessage("DOOR OPENED");

  // Exit switch: reaching an `exit` cell (with the door open ahead of it) wins.
  const playerCell = cellAt(Math.floor(player.x), Math.floor(player.y));
  const nearExit = playerCell?.type === "exit" || (playerCell?.type === "floor" && playerCell.room === "exit");
  if (game.mode === "live" && nearExit && game.doorOpen > 0.4) {
    game.mode = "cleared";
    game.modeT = 0;
    setHud((h) => ({ ...h, mode: "cleared" }));
    showMessage("EXIT REACHED — LEVEL CLEAR");
    speak(pickDoomTaunt(DOOM_TAUNTS_VICTORY));
  }

  // Status-message countdown: tick it down, clears the HUD line when done.
  if (game.messageT > 0) {
    game.messageT -= dt;
    if (game.messageT <= 0) {
      game.messageT = 0;
      setHud((h) => ({ ...h, message: "" }));
    }
  }

      // Mice AI + housekeeping run in every mode except the terminal one.
      if (game.mode !== "ending") {
        for (const m of game.mice) {
          if (!m.alive) {
            m.deathT += dt;
            continue;
          }
          m.hurtT = Math.max(0, m.hurtT - dt);
          m.attackCooldown = Math.max(0, m.attackCooldown - dt);
          const dx = player.x - m.x;
          const dy = player.y - m.y;
          const dist = Math.hypot(dx, dy);
          if (dist > MOUSE_AGGRO) continue;
    if (dist > MOUSE_MELEE_RANGE) {
      const nx = dx / dist;
      const ny = dy / dist;
      tryMove(m, nx * MOUSE_SPEED * dt, ny * MOUSE_SPEED * dt, 0.22, game.doorOpen);
          } else if (m.attackCooldown <= 0 && game.mode === "live") {
            applyDamage(player, MOUSE_DMG_MIN + Math.random() * (MOUSE_DMG_MAX - MOUSE_DMG_MIN));
            player.hurtFlash = 1;
            m.attackCooldown = 0.9;
            if (!game.taunting && Math.random() < 0.35) speak(pickDoomTaunt(DOOM_TAUNTS_HURT));
          }
        }
        for (const p of game.projectiles) {
          p.x += p.dx * dt;
          p.y += p.dy * dt;
    p.life -= dt;
    if (cellSolid(cellAt(Math.floor(p.x), Math.floor(p.y)), game.doorOpen)) {
      p.life = 0;
      continue;
    }
          for (const m of game.mice) {
            if (!m.alive) continue;
            if (Math.hypot(m.x - p.x, m.y - p.y) < 0.32) {
              damageMouse(m, p.kind === "cheese" ? 50 : 75, onMouseKilled);
              game.sparks.push({ x: m.x, y: m.y, life: 0.25 });
              sfx("hit");
              p.life = 0;
              break;
            }
          }
        }
        game.projectiles = game.projectiles.filter((p) => p.life > 0);
        for (const sp of game.sparks) sp.life -= dt;
        game.sparks = game.sparks.filter((sp) => sp.life > 0);
        player.fireCooldown = Math.max(0, player.fireCooldown - dt);
        player.meleeSwipeT = Math.max(0, player.meleeSwipeT - dt * 4);
        player.hurtFlash = Math.max(0, player.hurtFlash - dt * 1.4);
      }

      if (game.mode === "live" && player.health <= 0) {
        player.health = 0;
        game.mode = "dead";
        game.modeT = 0;
        setHud((h) => ({ ...h, mode: "dead", health: 0 }));
      } else if (game.mode === "live" && game.mice.every((m) => !m.alive)) {
        game.mode = "cleared";
        game.modeT = 0;
        setHud((h) => ({ ...h, mode: "cleared" }));
        speak(pickDoomTaunt(DOOM_TAUNTS_VICTORY));
      } else if (game.mode === "dead") {
        game.modeT += dt;
        if (game.modeT > END_HOLD_S) endGame("death");
      } else if (game.mode === "cleared") {
        game.modeT += dt;
        if (game.modeT > END_HOLD_S) endGame("victory");
      }

      render(ctx, game);
      setHud((h) => {
        const health = Math.max(0, Math.round(player.health));
        const armor = Math.max(0, Math.round(player.armor));
        const kills = game.mice.filter((m) => !m.alive).length;
        if (
          h.health === health &&
          h.armor === armor &&
          h.weapon === player.weapon &&
          h.ammoCheese === player.ammoCheese &&
          h.ammoTrap === player.ammoTrap &&
          h.kills === kills
        ) {
          return h;
        }
        return { ...h, health, armor, weapon: player.weapon, ammoCheese: player.ammoCheese, ammoTrap: player.ammoTrap, kills };
      });

      if (game.mode !== "ending") rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    return () => {
      mounted = false;
      cancelAnimationFrame(rafId);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      void ac?.close().catch(() => {});
    };
    // Intentionally mount-once: presenter/onFinished are read via refs (kept
    // fresh every render above) so this game loop is never torn down and
    // restarted mid-play — same "fresh object every render would restart an
    // in-flight effect" trap the other two eggs already dodge this way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rect = doomFaceRect(viewport.w, viewport.h);
  const barH = rect.size + DOOM_FACE_MARGIN * 2;
  const quit = () => {
    const game = gameRef.current;
    if (game.mode === "ending") return;
    game.mode = "ending";
    if (!endedRef.current) {
      endedRef.current = true;
      onFinishedRef.current();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[15] overflow-hidden select-none" style={{ background: "#000" }}>
      <div className="absolute inset-x-0 top-0" style={{ bottom: barH }}>
        <canvas
          ref={canvasRef}
          width={RES_W}
          height={RES_H}
          className="w-full h-full"
          style={{ imageRendering: "pixelated" }}
        />
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: "repeating-linear-gradient(to bottom, transparent 0px, transparent 2px, rgba(0,0,0,0.18) 2px, rgba(0,0,0,0.18) 4px)",
          }}
        />
      </div>

      {/* No portrait canvas here — her real, live <sv-presenter> element
          (positioned/repositioned by Flow.tsx's computeLayout doom branch)
          is what's actually visible at this rect; genuine pixelation of it
          isn't achievable (see the comment above this component's main
          effect for why). These corner brackets just frame wherever she
          actually sits, same amber accent as the rest of this HUD. */}
      <div
        className="fixed z-[22] pointer-events-none"
        style={{ left: rect.left - 6, top: rect.top - 6, width: rect.size + 12, height: rect.size + 12 }}
      >
        {[
          { left: 0, top: 0, borderWidth: "3px 0 0 3px" },
          { right: 0, top: 0, borderWidth: "3px 3px 0 0" },
          { left: 0, bottom: 0, borderWidth: "0 0 3px 3px" },
          { right: 0, bottom: 0, borderWidth: "0 3px 3px 0" },
        ].map((corner, i) => (
          <div key={i} className="absolute" style={{ ...corner, width: 18, height: 18, borderStyle: "solid", borderColor: "#e8c02a" }} />
        ))}
      </div>

      <button
        type="button"
        onClick={quit}
        aria-label="Quit DOOM egg"
        className="fixed z-[22] flex items-center justify-center rounded-full border-2 border-red-500 bg-black/70 text-red-400 font-mono font-bold"
        style={{ top: headerH + 8, right: 12, width: 36, height: 36 }}
      >
        ✕
      </button>

      {hud.hint && (
        <div
          className="fixed z-[22] font-mono text-[11px] tracking-wide text-lime-300 bg-black/60 px-2 py-1 rounded"
          style={{ top: headerH + 8, left: 12 }}
        >
          {hud.hint}
        </div>
      )}

      {hud.taunt && (
        <div
          className="fixed z-[22] font-mono text-xs text-center text-white bg-black/75 border border-white/40 rounded px-3 py-1.5"
          style={{ left: rect.left - 40, width: rect.size + 80, bottom: barH + 10 }}
        >
          {hud.taunt}
        </div>
      )}

      {hud.mode === "dead" && (
        <div className="fixed inset-x-0 top-1/3 z-[22] flex justify-center">
          <p className="font-mono text-4xl font-bold tracking-widest text-red-600" style={{ textShadow: "3px 3px 0 #000" }}>
            YOU DIED
          </p>
        </div>
      )}
      {hud.mode === "cleared" && (
        <div className="fixed inset-x-0 top-1/3 z-[22] flex justify-center">
          <p className="font-mono text-3xl font-bold tracking-widest text-lime-400" style={{ textShadow: "3px 3px 0 #000" }}>
            AREA CLEAR
          </p>
        </div>
      )}

  {/* Field order and grouping here match vanilla Doom's actual status
      bar (st_stuff.c: ST_AMMOX=44, ST_HEALTHX=90, ST_ARMSX=111,
      ST_FX=143, ST_ARMORX=221 on the 320-wide bar) — AMMO, HEALTH, and
      the ARMS weapon grid all sit LEFT of the face; ARMOR is alone on
      the right. An earlier version guessed AMMO+ARMS left / HEALTH+
      ARMOR right, which is wrong — verified against the Doom source
      and Doom Wiki rather than left as a guess. */}
  <div
    className="fixed inset-x-0 bottom-0 z-[16] flex items-stretch font-mono"
    style={{
      height: barH,
      // Vanilla's status bar is a "cement-like grey" surface, not brown:
      // a subtle horizontal grain over a dark base, with a hard top seam and
      // a bevel so it reads as a physical panel the face sits in.
      background:
        "repeating-linear-gradient(to bottom, rgba(0,0,0,0.16) 0px, rgba(0,0,0,0.16) 1px, transparent 1px, transparent 3px), linear-gradient(#6f6f68, #33322e)",
      borderTop: "4px solid #000",
      boxShadow: "inset 0 3px 0 rgba(255,255,255,0.10), inset 0 -3px 0 rgba(0,0,0,0.5)",
    }}
  >
    <div style={{ width: rect.left }} className="flex items-center justify-evenly px-1">
      <DoomStat label="AMMO" value={hud.weapon === "claws" ? "--" : hud.weapon === "cheese" ? hud.ammoCheese : hud.ammoTrap} />
      <DoomStat label="HEALTH" value={hud.health} />
      <div className="flex flex-col items-center gap-1">
        <div className="flex gap-1">
          {DOOM_WEAPONS.map((w, i) => (
            <div
              key={w}
              aria-label={DOOM_WEAPON_LABELS[w]}
              className="flex items-center justify-center rounded-sm border text-[10px] font-bold"
              style={{
                width: 18,
                height: 18,
                background: hud.weapon === w ? DOOM_YELLOW : "rgba(0,0,0,0.35)",
                color: hud.weapon === w ? "#2a1d12" : "#9a8a5f",
                borderColor: hud.weapon === w ? "#fff2c0" : "#5a5546",
                boxShadow: hud.weapon === w ? "0 0 5px #e8c02a" : "none",
              }}
            >
              {i + 1}
            </div>
          ))}
        </div>
        <span className="text-[8px] tracking-[0.25em]" style={{ color: DOOM_YELLOW }}>
          ARMS
        </span>
      </div>
    </div>
    <div style={{ width: rect.size }} aria-hidden />
    <div className="flex-1 flex flex-col items-center justify-center px-1">
      <DoomStat label="ARMOR" value={hud.armor} />
    </div>
    <div className="absolute right-3 bottom-1 flex flex-col items-end gap-0.5 text-[9px] leading-none" style={{ color: "#d8c86a" }}>
      <span>KILLS {hud.kills}/{DOOM_MOUSE_SPAWNS.length}</span>
      <span className="text-[8px] tracking-[0.2em]" style={{ color: "#7a6f4a" }}>
        {DOOM_WEAPON_LABELS[hud.weapon].toUpperCase()}
      </span>
    </div>
  </div>

  {/* Transient status-bar message (vanilla's message bar): a thin line just
      above the bar that shows pickups/door/exit notes then fades. */}
  {hud.message && (
    <div
      className="fixed inset-x-0 text-center font-mono text-[13px] tracking-[0.12em] text-lime-200"
      style={{ bottom: barH + 6, left: rect.left, right: rect.left, width: rect.size, textShadow: "2px 2px 0 #000" }}
    >
      {hud.message}
    </div>
  )}
    </div>,
    document.body,
  );
}
