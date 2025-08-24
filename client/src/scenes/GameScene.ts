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

  // ⬇️ Local prediction state for *me*
  private myPred = { x: 0, y: 0 };
  private myServerRef?: PlayerSchema;

  private lastSent = 0;
  private world = { w: 2000, h: 2000 };

  private fitCameraToScreen() {
    const w = this.scale.width;
    const h = this.scale.height;

    // Make the main camera fill the canvas
    this.cameras.main.setViewport(0, 0, w, h);
    this.cameras.main.setSize(w, h); // redundant but explicit
    this.cameras.resize(w, h); // ensure all cameras match size

    // Make sure zoom didn’t get changed somewhere
    this.cameras.main.setZoom(1);

    // Keep world bounds (so follow & scrolling still behave)
    this.cameras.main.setBounds(0, 0, this.world.w, this.world.h);
  }
  private fitCameraToCanvas() {
    const w = this.scale.width;
    const h = this.scale.height;
    const cam = this.cameras.main;

    // fill the canvas, always
    this.cameras.resize(w, h); // resize all cameras to canvas
    cam.setViewport(0, 0, w, h); // explicit viewport === canvas
    cam.setSize(w, h); // redundant but explicit
    cam.setZoom(1);
    cam.setBounds(0, 0, this.world.w, this.world.h);
    cam.setRoundPixels(true); // reduces subpixel jitter
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
    this.scale.on("resize", (size: Phaser.Structs.Size) => {
      this.fitCameraToCanvas();
    });
    this.join();
  }

  private async join() {
    this.room = await this.client.joinOrCreate("arena");
    this.room.onMessage("you", (m) => (this.meId = m.id));

    const $ = getStateCallbacks(this.room);

    // Arena size (synced from server)
    this.world.w = (this.room.state as any).width || 2000;
    this.world.h = (this.room.state as any).height || 2000;

    // Players: added
    $(this.room.state).players.onAdd((p: PlayerSchema, id: string) => {
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
        // Start camera on me
        this.cameras.main.startFollow(arc, true, 0.1, 0.1);
        this.fitCameraToCanvas();
        this.cameras.main.setBounds(0, 0, this.world.w, this.world.h);

        // Init local prediction from authoritative spawn
        this.myPred.x = p.x;
        this.myPred.y = p.y;
        this.myServerRef = p;
        this.cameras.main.startFollow(arc, true, 0.1, 0.1);
        this.fitCameraToScreen();
      }
    });

    // Players: removed
    $(this.room.state).players.onRemove((_p: PlayerSchema, id: string) => {
      this.sprites.get(id)?.destroy();
      this.labels.get(id)?.destroy();
      this.sprites.delete(id);
      this.labels.delete(id);
    });

    // Toggle patrol
    this.keyP.on("down", () => this.room.send("togglePatrol"));

    // Per-frame loop (get delta)
    this.events.on(Phaser.Scenes.Events.UPDATE, this.updateLoop, this);
  }

  private updateLoop(_time: number, delta: number) {
    // --- 1) Send input (throttled ~30/s) ---
    if (_time - this.lastSent > 33) {
      const up = this.keyW.isDown || this.cursors.up?.isDown;
      const down = this.keyS.isDown || this.cursors.down?.isDown;
      const left = this.keyA.isDown || this.cursors.left?.isDown;
      const right = this.keyD.isDown || this.cursors.right?.isDown;
      this.room?.send("input", { up, down, left, right });
      this.lastSent = _time;
    }

    // --- 2) Predict my own movement at render-rate ---
    const meSprite = this.meId ? this.sprites.get(this.meId) : undefined;
    const p = this.myServerRef;

    if (meSprite && p) {
      const dt = Math.min(delta, 50) / 1000; // clamp big spikes
      const speed = p.speed ?? 180;

      const up = this.keyW.isDown || this.cursors.up?.isDown;
      const down = this.keyS.isDown || this.cursors.down?.isDown;
      const left = this.keyA.isDown || this.cursors.left?.isDown;
      const right = this.keyD.isDown || this.cursors.right?.isDown;

      // If patrol is active, *follow server* (no prediction)
      if (p.patrol && !(up || down || left || right)) {
        this.myPred.x = Phaser.Math.Linear(this.myPred.x, p.x, 0.18);
        this.myPred.y = Phaser.Math.Linear(this.myPred.y, p.y, 0.18);
      } else {
        // Predict locally from inputs
        let dx = 0,
          dy = 0;
        if (up) dy -= speed * dt;
        if (down) dy += speed * dt;
        if (left) dx -= speed * dt;
        if (right) dx += speed * dt;

        // Normalize diagonal speed
        if (dx !== 0 && dy !== 0) {
          const inv = 1 / Math.sqrt(2);
          dx *= inv;
          dy *= inv;
        }

        this.myPred.x = clamp(this.myPred.x + dx, 0, this.world.w);
        this.myPred.y = clamp(this.myPred.y + dy, 0, this.world.h);

        // Gentle reconciliation: drift toward authoritative server pos
        const errX = p.x - this.myPred.x;
        const errY = p.y - this.myPred.y;
        const corr = 0.1; // lower = softer
        if (Math.abs(errX) + Math.abs(errY) > 0.2) {
          this.myPred.x += errX * corr;
          this.myPred.y += errY * corr;
        }
      }

      meSprite.x = this.myPred.x;
      meSprite.y = this.myPred.y;
      meSprite.setRotation(p.angle);
      this.labels.get(this.meId!)?.setPosition(meSprite.x, meSprite.y - 24);
    }

    // --- 3) Interpolate *remote* players as before ---
    const players = (this.room?.state as any)?.players;
    if (!players) return;

    players.forEach((rp: PlayerSchema, id: string) => {
      if (id === this.meId) return; // handled above

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
