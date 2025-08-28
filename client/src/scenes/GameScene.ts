import Phaser from "phaser";
import { Client, Room, getStateCallbacks } from "colyseus.js";

type PlayerSchema = {
  x: number;
  y: number;
  angle: number;
  color: string;
  patrol: boolean;
  tx: number;
  ty: number;
  speed: number;
  lastProcessedInput?: number;
};

export default class GameScene extends Phaser.Scene {
  private client!: Client;
  private room!: Room;
  private meId: string | null = null;

  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private keyW!: Phaser.Input.Keyboard.Key;
  private keyA!: Phaser.Input.Keyboard.Key;
  private keyS!: Phaser.Input.Keyboard.Key;
  private keyD!: Phaser.Input.Keyboard.Key;
  private keyP!: Phaser.Input.Keyboard.Key;

  private sprites = new Map<string, Phaser.GameObjects.Arc>();
  private labels = new Map<string, Phaser.GameObjects.Text>();

  // Local prediction state for *me*
  private myPred = { x: 0, y: 0 };

  // reconciliation buffers
  private seq = 0;
  private pending: Array<{
    seq: number;
    up: boolean;
    down: boolean;
    left: boolean;
    right: boolean;
    dt: number; // ms at time of send
  }> = [];

  private lastSent = 0;
  private world = { w: 2000, h: 2000 };

  private fitCameraToCanvas() {
    const w = this.scale.width;
    const h = this.scale.height;
    const cam = this.cameras.main;

    this.cameras.resize(w, h);
    cam.setViewport(0, 0, w, h);
    cam.setSize(w, h);
    cam.setZoom(1);
    cam.setBounds(0, 0, this.world.w, this.world.h);
    cam.setRoundPixels(true);
  }

  create() {
    const endpoint = import.meta.env.DEV
      ? "ws://localhost:2567"
      : location.origin.replace(/^http/, "ws");

    this.client = new Client(endpoint);

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.keyW = this.input.keyboard!.addKey("W");
    this.keyA = this.input.keyboard!.addKey("A");
    this.keyS = this.input.keyboard!.addKey("S");
    this.keyD = this.input.keyboard!.addKey("D");
    this.keyP = this.input.keyboard!.addKey("P");

    this.addGrid();
    this.scale.on("resize", () => this.fitCameraToCanvas());
    this.join();
  }

  private async join() {
    this.room = await this.client.joinOrCreate("arena");
    this.room.onMessage("you", (m) => (this.meId = m.id));

    // 1) Wait for first full state
    this.room.onStateChange.once((state: any) => {
      // sync arena bounds
      this.world.w = state.width || 2000;
      this.world.h = state.height || 2000;

      // 2) Attach listeners via getStateCallbacks (portable & reliable)
      const $ = getStateCallbacks(this.room);

      $(this.room.state).players.onAdd((p: PlayerSchema, id: string) => {
        this.handlePlayerAdd(p, id);
      });

      $(this.room.state).players.onRemove((_p: PlayerSchema, id: string) => {
        this.handlePlayerRemove(id);
      });

      $(this.room.state).players.onChange((p: PlayerSchema, id: string) => {
        this.handlePlayerChange(p, id);
      });

      // 3) Render any players already present at this moment
      (this.room.state as any).players.forEach(
        (p: PlayerSchema, id: string) => {
          this.handlePlayerAdd(p, id);
        }
      );

      // Start main loop now that state exists
      this.events.on(Phaser.Scenes.Events.UPDATE, this.updateLoop, this);
    });

    // Toggle patrol
    this.keyP.on("down", () => this.room.send("togglePatrol"));
  }

  private handlePlayerAdd(p: PlayerSchema, id: string) {
    if (this.sprites.has(id)) return;

    const arc = this.add.circle(p.x, p.y, 14, 0xffffff);
    arc.setStrokeStyle(2, 0xffffff, 0.5);
    arc.setFillStyle(Phaser.Display.Color.HexStringToColor(p.color).color);

    const label = this.add
      .text(p.x, p.y - 24, id.slice(0, 4), {
        fontSize: "12px",
        color: "#cde6ff",
      })
      .setOrigin(0.5);

    this.sprites.set(id, arc);
    this.labels.set(id, label);

    if (id === this.room.sessionId) {
      this.cameras.main.startFollow(arc, true, 0.1, 0.1);
      this.fitCameraToCanvas();
      this.cameras.main.setBounds(0, 0, this.world.w, this.world.h);

      // init prediction from server spawn
      this.myPred.x = p.x;
      this.myPred.y = p.y;
    }
  }

  private handlePlayerRemove(id: string) {
    this.sprites.get(id)?.destroy();
    this.labels.get(id)?.destroy();
    this.sprites.delete(id);
    this.labels.delete(id);
  }

  private handlePlayerChange(p: PlayerSchema, id: string) {
    // reconciliation for *my* player
    if (id === this.meId) {
      this.myPred.x = p.x;
      this.myPred.y = p.y;

      const last = p.lastProcessedInput || 0;
      this.pending = this.pending.filter((i) => i.seq > last);

      const speed = p.speed ?? 180;
      for (const i of this.pending) {
        let dx = 0,
          dy = 0;
        if (i.up) dy -= 1;
        if (i.down) dy += 1;
        if (i.left) dx -= 1;
        if (i.right) dx += 1;
        if (dx && dy) {
          const inv = 1 / Math.sqrt(2);
          dx *= inv;
          dy *= inv;
        }
        const dt = Math.min(i.dt, 50) / 1000;
        this.myPred.x = clamp(this.myPred.x + dx * speed * dt, 0, this.world.w);
        this.myPred.y = clamp(this.myPred.y + dy * speed * dt, 0, this.world.h);
      }

      const me = this.sprites.get(this.meId!);
      if (me) {
        me.x = this.myPred.x;
        me.y = this.myPred.y;
        me.setRotation(p.angle);
      }
      this.labels
        .get(this.meId!)
        ?.setPosition(this.myPred.x, this.myPred.y - 24);
    }
  }

  private updateLoop(time: number, delta: number) {
    if (!this.room || !(this.room.state as any)?.players) return;

    // 1) gather inputs
    const up = this.keyW.isDown || this.cursors.up?.isDown || false;
    const down = this.keyS.isDown || this.cursors.down?.isDown || false;
    const left = this.keyA.isDown || this.cursors.left?.isDown || false;
    const right = this.keyD.isDown || this.cursors.right?.isDown || false;

    // 2) send at ~30/s + record for reconciliation
    if (time - this.lastSent > 33) {
      const msg = { seq: ++this.seq, up, down, left, right };
      this.room.send("input", msg);
      this.pending.push({ ...msg, dt: Math.min(delta, 50) });
      if (this.pending.length > 256)
        this.pending.splice(0, this.pending.length - 256);
      this.lastSent = time;
    }

    // 3) predict me every frame
    const meSprite = this.meId ? this.sprites.get(this.meId) : undefined;
    const serverMe = this.meId
      ? ((this.room.state as any).players.get(this.meId) as
          | PlayerSchema
          | undefined)
      : undefined;

    if (meSprite && serverMe) {
      const dt = Math.min(delta, 50) / 1000;
      const speed = serverMe.speed ?? 180;

      if (serverMe.patrol && !(up || down || left || right)) {
        this.myPred.x = Phaser.Math.Linear(this.myPred.x, serverMe.x, 0.18);
        this.myPred.y = Phaser.Math.Linear(this.myPred.y, serverMe.y, 0.18);
      } else {
        let dx = 0,
          dy = 0;
        if (up) dy -= speed * dt;
        if (down) dy += speed * dt;
        if (left) dx -= speed * dt;
        if (right) dx += speed * dt;
        if (dx !== 0 && dy !== 0) {
          const inv = 1 / Math.sqrt(2);
          dx *= inv;
          dy *= inv;
        }
        this.myPred.x = clamp(this.myPred.x + dx, 0, this.world.w);
        this.myPred.y = clamp(this.myPred.y + dy, 0, this.world.h);

        // light safety drift toward server
        const errX = serverMe.x - this.myPred.x;
        const errY = serverMe.y - this.myPred.y;
        const corr = 0.1;
        if (Math.abs(errX) + Math.abs(errY) > 0.2) {
          this.myPred.x += errX * corr;
          this.myPred.y += errY * corr;
        }
      }

      meSprite.x = this.myPred.x;
      meSprite.y = this.myPred.y;
      meSprite.setRotation(serverMe.angle);
      this.labels.get(this.meId!)?.setPosition(meSprite.x, meSprite.y - 24);
    }

    // 4) interpolate remotes
    const players = (this.room.state as any).players;
    players?.forEach((rp: PlayerSchema, id: string) => {
      if (id === this.meId) return;
      const sprite = this.sprites.get(id);
      const label = this.labels.get(id);
      if (!sprite || !label) return;

      sprite.x = Phaser.Math.Linear(sprite.x, rp.x, 0.18);
      sprite.y = Phaser.Math.Linear(sprite.y, rp.y, 0.18);
      sprite.setRotation(rp.angle);
      label.setPosition(sprite.x, sprite.y - 24);
    });
  }

  private addGrid() {
    const g = this.add.graphics({ x: 0, y: 0 });
    const size = 50;
    const w = this.world.w;
    const h = this.world.h;
    g.lineStyle(1, 0x1f2a3a, 0.6);
    for (let x = 0; x <= w; x += size) g.lineBetween(x, 0, x, h);
    for (let y = 0; y <= h; y += size) g.lineBetween(0, y, w, y);
    g.lineStyle(2, 0x2b3a52, 1);
    g.strokeRect(0, 0, w, h);
  }
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
