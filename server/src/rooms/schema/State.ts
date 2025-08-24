import { Schema, type, MapSchema } from "@colyseus/schema";

export class Player extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") angle: number = 0;
  @type("number") speed: number = 180;
  @type("string") color: string = "#00c2ff";
  @type("boolean") patrol: boolean = false;
  @type("number") tx: number = 0; // patrol target x
  @type("number") ty: number = 0; // patrol target y
}

export class ArenaState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type("number") width: number = 2000;
  @type("number") height: number = 2000;
}
