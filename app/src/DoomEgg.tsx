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
}

function isWall(x: number, y: number): boolean {
  const mx = Math.floor(x);
  const my = Math.floor(y);
  const row = DOOM_MAP[my];
  if (!row) return true;
  return row[mx] !== 0;
}
function collides(x: number, y: number, r: number): boolean {
  return isWall(x - r, y - r) || isWall(x + r, y - r) || isWall(x - r, y + r) || isWall(x + r, y + r);
}
function tryMove(ent: { x: number; y: number }, dx: number, dy: number, r: number) {
  if (!collides(ent.x + dx, ent.y, r)) ent.x += dx;
  if (!collides(ent.x, ent.y + dy, r)) ent.y += dy;
}
function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
function castRay(px: number, py: number, angle: number): { dist: number; side: number } {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const step = 0.05;
  const maxDist = 16;
  let x = px;
  let y = py;
  let dist = 0;
  while (dist < maxDist) {
    x += cos * step;
    y += sin * step;
    dist += step;
    if (isWall(x, y)) {
      const fx = x - Math.floor(x);
      const fy = y - Math.floor(y);
      const side = Math.min(fx, 1 - fx) < Math.min(fy, 1 - fy) ? 1 : 0;
      return { dist, side };
    }
  }
  return { dist: maxDist, side: 0 };
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
  if (target) {
    const dx = target.x - player.x;
    const dy = target.y - player.y;
    const rel = normalizeAngle(Math.atan2(dy, dx) - player.angle);
    turn = Math.max(-1, Math.min(1, rel * 2.2));
    if (Math.abs(rel) < 0.55) forward = bestD > 1.4 ? 1 : 0.25;
    if (Math.abs(rel) < 0.22) {
      player.weapon = bestD > 3 ? "cheese" : "claws";
      fireWeapon(game, sfx, onKill);
    }
  } else {
    forward = 0.35;
    turn = 0.4;
  }
  player.angle += turn * TURN_SPEED * dt;
  tryMove(player, Math.cos(player.angle) * forward * MOVE_SPEED * dt, Math.sin(player.angle) * forward * MOVE_SPEED * dt, 0.2);
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

function drawWeaponView(ctx: CanvasRenderingContext2D, player: Player) {
  const bobY = Math.sin(player.bobT) * 2;
  const swipe = player.meleeSwipeT;
  const cx = RES_W / 2;
  const baseY = RES_H - 4 + bobY;
  ctx.save();
  if (player.weapon === "claws") {
    // A black cat forearm swings in from off-screen bottom-right and slashes
    // across to upper-left as `swipe` decays 1 (just fired) -> 0 (done) —
    // empty-handed at rest, matching "we should see the arm swing out" (not
    // a weapon permanently held in frame like the other two).
    if (swipe > 0.02) {
      const t = 1 - swipe; // 0 at the fire instant -> 1 as the slash completes
      const shoulderX = cx + 70;
      const shoulderY = RES_H + 14;
      const reach = 92;
      const startA = -2.35; // pointing down-right, mostly off-screen
      const endA = -0.55; // pointing up-left, fully into frame
      const a = startA + (endA - startA) * Math.min(1, t * 1.5);
      const elbowX = shoulderX + Math.cos(a) * reach * 0.52;
      const elbowY = shoulderY + Math.sin(a) * reach * 0.52;
      const pawX = shoulderX + Math.cos(a) * reach;
      const pawY = shoulderY + Math.sin(a) * reach;

      ctx.strokeStyle = "#26232a";
      ctx.lineWidth = 20;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(shoulderX, shoulderY);
      ctx.lineTo(elbowX, elbowY);
      ctx.lineTo(pawX, pawY);
      ctx.stroke();

      // Paw pad
      ctx.fillStyle = "#302c33";
      ctx.beginPath();
      ctx.arc(pawX, pawY, 15, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#4a4450";
      ctx.beginPath();
      ctx.arc(pawX - 3, pawY - 3, 5, 0, Math.PI * 2);
      ctx.fill();

      // Four extended claws fanning from the paw's leading edge, bright
      // (near-white) at the peak of the swing to sell the slash.
      ctx.strokeStyle = swipe > 0.45 ? "#fdfdf5" : "#d8d2c4";
      ctx.lineWidth = 3.5;
      ctx.lineCap = "round";
      for (let i = -1.5; i <= 1.5; i++) {
        const ca = a + i * 0.2;
        ctx.beginPath();
        ctx.moveTo(pawX + Math.cos(ca) * 10, pawY + Math.sin(ca) * 10);
        ctx.lineTo(pawX + Math.cos(ca) * 32, pawY + Math.sin(ca) * 32);
        ctx.stroke();
      }
      // Motion-streak arcs behind the claws, fading with the swing.
      if (swipe > 0.3) {
        ctx.strokeStyle = `rgba(255,255,255,${(swipe - 0.3) * 0.5})`;
        ctx.lineWidth = 2;
        for (const r of [22, 34, 46]) {
          ctx.beginPath();
          ctx.arc(shoulderX, shoulderY, r + reach * 0.55, a - 0.5, a + 0.1);
          ctx.stroke();
        }
      }
    }
  } else if (player.weapon === "cheese") {
    const kick = swipe * 8;
    ctx.fillStyle = "#f0c14b";
    ctx.beginPath();
    ctx.arc(cx, baseY - 20 - kick, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#caa23a";
    ctx.beginPath();
    ctx.arc(cx - 8, baseY - 26 - kick, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + 9, baseY - 14 - kick, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#555";
    ctx.fillRect(cx - 5, baseY - 46 - kick, 10, 22);
  } else {
    const throwT = swipe;
    ctx.fillStyle = "#777";
    ctx.fillRect(cx - 20, baseY - 26 - throwT * 20, 40, 18);
    ctx.strokeStyle = "#ccc";
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - 20, baseY - 26 - throwT * 20, 40, 18);
    ctx.beginPath();
    ctx.moveTo(cx - 16, baseY - 26 - throwT * 20);
    ctx.lineTo(cx - 4, baseY - 40 - throwT * 20);
    ctx.moveTo(cx + 16, baseY - 26 - throwT * 20);
    ctx.lineTo(cx + 4, baseY - 40 - throwT * 20);
    ctx.stroke();
  }
  ctx.restore();
}

function render(ctx: CanvasRenderingContext2D, game: GameState) {
  const { player } = game;
  ctx.fillStyle = "#3a3a3f";
  ctx.fillRect(0, 0, RES_W, RES_H / 2);
  ctx.fillStyle = "#4a2f22";
  ctx.fillRect(0, RES_H / 2, RES_W, RES_H / 2);

  for (let col = 0; col < RES_W; col++) {
    const rayAngle = player.angle - FOV / 2 + (col / RES_W) * FOV;
    const { dist, side } = castRay(player.x, player.y, rayAngle);
    const corrected = Math.max(0.0001, dist * Math.cos(rayAngle - player.angle));
    game.zbuffer[col] = corrected;
    const wallH = Math.min(RES_H * 4, RES_H / corrected);
    const y0 = (RES_H - wallH) / 2;
    const shade = Math.max(0.18, 1 - corrected / 11);
    const base = side ? [104, 58, 40] : [140, 82, 48];
    ctx.fillStyle = `rgb(${(base[0] * shade) | 0},${(base[1] * shade) | 0},${(base[2] * shade) | 0})`;
    ctx.fillRect(col, y0, 1, wallH);
  }

  type Billboard = { x: number; y: number; dist: number; draw: () => void };
  const boards: Billboard[] = [];
  for (const m of game.mice) {
    if (!m.alive && m.deathT > 1.2) continue;
    const dx = m.x - player.x;
    const dy = m.y - player.y;
    const dist = Math.hypot(dx, dy);
    const rel = normalizeAngle(Math.atan2(dy, dx) - player.angle);
    if (Math.abs(rel) > FOV / 2 + 0.3 || dist < 0.15) continue;
    const screenX = (0.5 + rel / FOV) * RES_W;
    const col = Math.max(0, Math.min(RES_W - 1, Math.round(screenX)));
    if (dist > game.zbuffer[col] + 0.15) continue;
    const size = Math.min(RES_H * 1.6, (RES_H / dist) * 0.62);
    const cy = RES_H / 2 + (RES_H / dist) * 0.14;
    boards.push({ x: screenX, y: cy, dist, draw: () => drawMouseSprite(ctx, screenX, cy, size, m.hurtT, m.alive ? 0 : Math.min(1, m.deathT * 2)) });
  }
  for (const p of game.projectiles) {
    const dx = p.x - player.x;
    const dy = p.y - player.y;
    const dist = Math.hypot(dx, dy);
    const rel = normalizeAngle(Math.atan2(dy, dx) - player.angle);
    if (Math.abs(rel) > FOV / 2 + 0.3 || dist < 0.1) continue;
    const screenX = (0.5 + rel / FOV) * RES_W;
    const col = Math.max(0, Math.min(RES_W - 1, Math.round(screenX)));
    if (dist > game.zbuffer[col] + 0.1) continue;
    const size = Math.min(RES_H, (RES_H / dist) * 0.16);
    const cy = RES_H / 2 + (RES_H / dist) * 0.14;
    boards.push({
      x: screenX,
      y: cy,
      dist,
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
    const size = Math.min(RES_H, (RES_H / dist) * 0.2);
    const cy = RES_H / 2 + (RES_H / dist) * 0.14;
    boards.push({
      x: screenX,
      y: cy,
      dist: dist - 0.05,
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
    hint: "Touch a control to fight — autoplay in 4s",
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
      const controlKeys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "w", "a", "s", "d", "W", "A", "S", "D", " ", "1", "2", "3"];
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
      if (["arrowup", "arrowdown", "arrowleft", "arrowright"].includes(nk.toLowerCase()) || ["w", "a", "s", "d"].includes(nk)) {
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
        const turn = (k.has("ArrowRight") || k.has("d") ? 1 : 0) - (k.has("ArrowLeft") || k.has("a") ? 1 : 0);
        player.angle += turn * TURN_SPEED * dt;
        tryMove(player, Math.cos(player.angle) * forward * MOVE_SPEED * dt, Math.sin(player.angle) * forward * MOVE_SPEED * dt, 0.2);
        player.bobT += forward !== 0 ? dt * 9 : dt * 2;
        game.idleTauntT -= dt;
        if (game.idleTauntT <= 0) {
          game.idleTauntT = 5 + Math.random() * 3;
          if (!game.taunting && Math.random() < 0.6) speak(pickDoomTaunt(DOOM_TAUNTS_IDLE));
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
            tryMove(m, nx * MOUSE_SPEED * dt, ny * MOUSE_SPEED * dt, 0.22);
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
          if (isWall(p.x, p.y)) {
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
          // Vanilla's status bar is a "cement-like grey" texture, not brown.
          background: "linear-gradient(#6b6b64, #302f2b)",
          borderTop: "4px solid #000",
          boxShadow: "inset 0 3px 0 rgba(255,255,255,0.08)",
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
        <div className="flex-1 flex items-center justify-center px-1">
          <DoomStat label="ARMOR" value={hud.armor} />
        </div>
        <div className="absolute right-2 bottom-1 text-[8px] tracking-wide" style={{ color: "#a89c78" }}>
          KILLS {hud.kills}/{DOOM_MOUSE_SPAWNS.length}
        </div>
      </div>
    </div>,
    document.body,
  );
}
