import { type Client, Room } from "@colyseus/core";
import { ArenaState, Player } from "./schema/State.js";

type InputMessage = {
  up?: boolean;
  down?: boolean;
  left?: boolean;
  right?: boolean;
};

export class ArenaRoom extends Room<ArenaState> {
  maxClients = 20;

  // 30 Hz simulation (unchanged), 20 Hz patch stream to clients
  readonly TICK_MS = 1000 / 30;
  readonly PATCH_RATE_MS = 1000 / 20;

  onCreate(_options: any) {
    this.setState(new ArenaState());

    // NEW: send state patches at 20 Hz
    this.setPatchRate(this.PATCH_RATE_MS);

    // Handle player input (authoritative)
    this.onMessage("input", (client, data: InputMessage) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;

      if (data.up || data.down || data.left || data.right) p.patrol = false;

      const step = p.speed * (this.TICK_MS / 1000);
      let dx = 0,
        dy = 0;
      if (data.up) dy -= step;
      if (data.down) dy += step;
      if (data.left) dx -= step;
      if (data.right) dx += step;

      if (dx !== 0 || dy !== 0) {
        // NEW: quantize to 2 decimals before writing to schema
        p.x = q2(clamp(p.x + dx, 0, this.state.width));
        p.y = q2(clamp(p.y + dy, 0, this.state.height));
        p.angle = Math.atan2(dy, dx);
      }
    });

    this.onMessage("togglePatrol", (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      p.patrol = !p.patrol;
      if (p.patrol) this.assignNewWaypoint(p);
    });

    // Fixed tick simulation loop (patrol AI)
    this.clock.setInterval(() => this.simulate(), this.TICK_MS);
  }

  onJoin(client: Client) {
    const p = new Player();
    p.x = Math.random() * this.state.width;
    p.y = Math.random() * this.state.height;
    p.color = randomColor();
    this.state.players.set(client.sessionId, p);

    client.send("you", { id: client.sessionId });
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
  }

  private simulate() {
    const dt = this.TICK_MS / 1000;
    this.state.players.forEach((p) => {
      if (!p.patrol) return;
      const dx = p.tx - p.x;
      const dy = p.ty - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 5) {
        this.assignNewWaypoint(p);
        return;
      }
      const vx = (dx / dist) * p.speed;
      const vy = (dy / dist) * p.speed;

      // NEW: quantize here too
      p.x = q2(clamp(p.x + vx * dt, 0, this.state.width));
      p.y = q2(clamp(p.y + vy * dt, 0, this.state.height));
      p.angle = Math.atan2(vy, vx);
    });
  }

  private assignNewWaypoint(p: Player) {
    const margin = 50;
    p.tx = margin + Math.random() * (this.state.width - margin * 2);
    p.ty = margin + Math.random() * (this.state.height - margin * 2);
  }
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

// NEW: 2-decimal quantizer
function q2(n: number) {
  return Math.round(n * 100) / 100;
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
