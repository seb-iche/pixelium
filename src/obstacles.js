import { CELL_SIZE } from './world.js';

export function generateObstacles(world) {
  world.obstacles = [];
  world.permanentObstacles = new Set();

  const cols = Math.floor(world.W / CELL_SIZE);
  const rows = Math.floor(world.H / CELL_SIZE);
  const count = 6 + Math.floor(Math.random() * 6);

  for (let i = 0; i < count; i++) {
    const tier = Math.random();
    const w = tier < 0.3
      ? 4  + Math.floor(Math.random() * 6)
      : tier < 0.7
        ? 10 + Math.floor(Math.random() * 12)
        : 20 + Math.floor(Math.random() * 20);
    const h = Math.floor(w * (0.4 + Math.random() * 0.6));
    const depth = 4 + Math.floor(Math.random() * 10);
    const gx = 4 + Math.floor(Math.random() * (cols - w - 8));
    const gy = 4 + Math.floor(Math.random() * (rows - h - 8));

    world.obstacles.push({ gx, gy, w, h, depth });

    for (let ox = 0; ox < w; ox++) {
      for (let oy = 0; oy < h; oy++) {
        const key = `${gx + ox},${gy + oy}`;
        world.occupied.add(key);
        world.permanentObstacles.add(key);
      }
    }
  }
}