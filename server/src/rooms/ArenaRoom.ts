import { type Client, Room } from "@colyseus/core";
import { ArenaState, Player } from "./schema/State.js";

type InputState = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
};

type InputMessage = Partial<InputState> & { seq?: number };

const MAX_INPUTS_PER_SEC = 60;

export class ArenaRoom extends Room<ArenaState> {
  maxClients = 20;

  /** Simulation tick (authoritative). */
  readonly TICK_MS = 1000 / 30;

  /** Simple cooldown to avoid message spam for toggling patrol. */
  readonly TOGGLE_COOLDOWN_MS = 250;

  /** Per-client current input snapshot (zero-trust: server decides). */
  private inputs = new Map<string, InputState>();

  /** Per-client last time they toggled patrol (ms since epoch). */
  private lastToggleAt = new Map<string, number>();

  /** Per-client token bucket to rate-limit input messages. */
  private inputBudget = new Map<string, { tokens: number; last: number }>();

  onCreate(_options: any) {
    this.setState(new ArenaState());

    // Send state patches ~20 Hz (bandwidth friendly).
    this.setPatchRate(20);

    // Store current input snapshot per client (no movement here!)
    this.onMessage("input", (client, data: InputMessage) => {
      // --- rate limit via token bucket ---
      const bucket = this.inputBudget.get(client.sessionId);
      if (!bucket) return;
      const now = Date.now();
      const refill = ((now - bucket.last) / 1000) * MAX_INPUTS_PER_SEC;
      bucket.tokens = Math.min(MAX_INPUTS_PER_SEC, bucket.tokens + refill);
      bucket.last = now;
      if (bucket.tokens < 1) return; // drop if out of tokens
      bucket.tokens -= 1;

      // --- merge input snapshot ---
      const next: InputState = {
        up: !!data.up,
        down: !!data.down,
        left: !!data.left,
        right: !!data.right,
      };
      this.inputs.set(client.sessionId, next);

      // record last processed input seq for reconciliation
      const p = this.state.players.get(client.sessionId);
      if (p && typeof data.seq === "number") {
        p.lastProcessedInput = data.seq;
      }

      // Any manual input cancels patrol
      if (p && (next.up || next.down || next.left || next.right)) {
        p.patrol = false;
      }
    });

    // Toggle patrol mode (with tiny cooldown)
    this.onMessage("togglePatrol", (client) => {
      const now = Date.now();
      const last = this.lastToggleAt.get(client.sessionId) ?? 0;
      if (now - last < this.TOGGLE_COOLDOWN_MS) return;
      this.lastToggleAt.set(client.sessionId, now);

      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      p.patrol = !p.patrol;
      if (p.patrol) this.assignNewWaypoint(p);
    });

    // Single authoritative fixed-tick for everyone (players + AI)
    this.clock.setInterval(() => this.simulate(), this.TICK_MS);
  }

  onJoin(client: Client) {
    const p = new Player();
    p.x = Math.random() * this.state.width;
    p.y = Math.random() * this.state.height;
    p.color = randomColor();

    this.state.players.set(client.sessionId, p);
    this.inputs.set(client.sessionId, {
      up: false,
      down: false,
      left: false,
      right: false,
    });
    this.lastToggleAt.set(client.sessionId, 0);
    this.inputBudget.set(client.sessionId, {
      tokens: MAX_INPUTS_PER_SEC,
      last: Date.now(),
    });

    // Tell the client their id (used by the frontend to set camera, prediction, etc.)
    client.send("you", { id: client.sessionId });
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.lastToggleAt.delete(client.sessionId);
    this.inputBudget.delete(client.sessionId);
  }

  /** Authoritative simulation step (30 Hz). */
  private simulate() {
    const dt = this.TICK_MS / 1000;

    this.state.players.forEach((p: Player, id: string) => {
      const input = this.inputs.get(id) ?? {
        up: false,
        down: false,
        left: false,
        right: false,
      };

      // If patrol is active AND there is no manual input, run patrol AI
      if (p.patrol && !(input.up || input.down || input.left || input.right)) {
        const dx = p.tx - p.x;
        const dy = p.ty - p.y;
        const dist = Math.hypot(dx, dy);

        if (dist < 5) {
          this.assignNewWaypoint(p);
          return;
        }

        const vx = (dx / (dist || 1)) * p.speed;
        const vy = (dy / (dist || 1)) * p.speed;

        p.x = clamp(p.x + vx * dt, 0, this.state.width);
        p.y = clamp(p.y + vy * dt, 0, this.state.height);

        const ang = Math.atan2(vy, vx);
        if (Number.isFinite(ang)) p.angle = ang;

        return;
      }

      // Otherwise, authoritative movement from input snapshot
      let ix = 0;
      let iy = 0;
      if (input.up) iy -= 1;
      if (input.down) iy += 1;
      if (input.left) ix -= 1;
      if (input.right) ix += 1;

      if (ix !== 0 || iy !== 0) {
        // Normalize diagonal
        if (ix !== 0 && iy !== 0) {
          const inv = 1 / Math.sqrt(2);
          ix *= inv;
          iy *= inv;
        }

        const vx = ix * p.speed;
        const vy = iy * p.speed;

        p.x = clamp(p.x + vx * dt, 0, this.state.width);
        p.y = clamp(p.y + vy * dt, 0, this.state.height);

        const ang = Math.atan2(vy, vx);
        if (Number.isFinite(ang)) p.angle = ang;
      }
    });
  }

  /** Pick a fresh patrol waypoint inside the arena with a small margin. */
  private assignNewWaypoint(p: Player) {
    const margin = 50;
    p.tx = margin + Math.random() * (this.state.width - margin * 2);
    p.ty = margin + Math.random() * (this.state.height - margin * 2);
  }
}

/** Inclusive clamp. */
function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function randomColor() {
  const hues = [
    "#00c2ff",
    "#ff4d4d",
    "#ffd166",
    "#06d6a0",
    "#a06bff",
    "#ff7ab6",
  ];
  return hues[(Math.random() * hues.length) | 0];
}
