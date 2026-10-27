import './style.css';
import { Game } from './game/game';

// Service worker: production only (dev has no hashed URLs; a worker left on localhost would only confuse vite dev).
// Scope = Vite base, e.g. /heartbeat-villa/, so it never sees the other github.io project sites on this origin.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
    .catch((e) => console.warn('[sw] registration failed', e));
}

const game = new Game();
if (import.meta.env.DEV) (window as unknown as { game: Game }).game = game;
game.boot().catch((e) => {
  console.error(e);
  const hint = document.querySelector('#loading .hint');
  if (hint) hint.textContent = `加载失败：${(e as Error).message ?? e}。请使用最新版 Chrome / Edge / Safari。`;
  document.querySelector('#loading')?.classList.remove('backdrop', 'gone');
});
