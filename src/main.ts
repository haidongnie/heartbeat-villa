import './style.css';
import { Game } from './game/game';

const game = new Game();
if (import.meta.env.DEV) (window as unknown as { game: Game }).game = game;
game.boot().catch((e) => {
  console.error(e);
  const hint = document.querySelector('#loading .hint');
  if (hint) hint.textContent = `加载失败：${(e as Error).message ?? e}。请使用最新版 Chrome / Edge / Safari。`;
});
