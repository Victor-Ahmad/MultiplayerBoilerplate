import Phaser from "phaser";
import GameScene from "./scenes/GameScene";

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: "app", // ⬅️ mount into #app
  backgroundColor: "#0b0f14",
  scale: {
    mode: Phaser.Scale.RESIZE, // fill parent
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: "100%", // ⬅️ with RESIZE, % works (labs example)
    height: "100%",
  },
  physics: {
    default: "arcade",
    arcade: {
      gravity: {
        y: 0,
        x: 0,
      },
      debug: false,
    },
  },
  scene: [GameScene],
});

window.addEventListener("resize", () => {
  game.scale.resize(window.innerWidth, window.innerHeight);
});
