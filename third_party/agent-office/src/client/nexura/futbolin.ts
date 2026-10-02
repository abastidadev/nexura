// nexura: the futbolín of the game room (a game of Nexura's shop), played from above in a window. Each
// side has its four rods (goalkeeper, defence, midfield, attack) that slide together; a player touching
// the ball sends it on towards the other goal, harder while you hold the kick. First to five. Against
// the machine, a win pays coins (capped a day by Nexura); two people can share the keyboard.
import { h, openModal, toast } from '../ui/dom';
import { loadWallet, nexura } from './wallet';

const W = 720;
const H = 420;
const GOAL = 130;
const BALL_R = 8;
const MAN = { w: 10, h: 22 };
const GOALS_TO_WIN = 5;
/** Each rod: its x, how many players, and the gap between them. Blue's from the left; red's mirrored. */
const RODS = [
  { x: 50, n: 1, gap: 0 },
  { x: 150, n: 2, gap: 150 },
  { x: 330, n: 5, gap: 72 },
  { x: 510, n: 3, gap: 110 },
];

type Side = { offset: number; kick: number; score: number };

function men(side: 'blue' | 'red', offset: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const rod of RODS) {
    const x = side === 'blue' ? rod.x : W - rod.x;
    const span = (rod.n - 1) * rod.gap;
    for (let i = 0; i < rod.n; i++) out.push({ x, y: H / 2 - span / 2 + i * rod.gap + offset });
  }
  return out;
}

export function openFutbolin(): void {
  let twoPlayers = false;
  const canvas = h('canvas.nx-futbolin', { width: W, height: H }) as HTMLCanvasElement;
  const g = canvas.getContext('2d')!;
  const score = h('div.nx-row', {}, h('span.grow', {}, ''));
  const modeButton = h('button.btn', { type: 'button' }, '👥 Dos jugadores');
  const help = h('p.nx-muted', {}, '');
  const blue: Side = { offset: 0, kick: 0, score: 0 };
  const red: Side = { offset: 0, kick: 0, score: 0 };
  const ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
  const keys = new Set<string>();
  let over = false;
  let paused = 1.2;

  const describe = () => {
    help.textContent = twoPlayers ? 'Azul: W/S para mover, Espacio para chutar · Rojo: ↑/↓ para mover, Enter para chutar' : 'W/S (o ↑/↓) para mover tus barras, Espacio para chutar. Ganas monedas al ganar a la máquina.';
    modeButton.textContent = twoPlayers ? '🤖 Contra la máquina' : '👥 Dos jugadores';
  };
  const reset = (toward: 1 | -1) => {
    ball.x = W / 2;
    ball.y = H / 2;
    ball.vx = 220 * toward;
    ball.vy = (Math.random() - 0.5) * 160;
    paused = 0.8;
  };
  const restart = () => {
    blue.score = red.score = 0;
    over = false;
    reset(Math.random() < 0.5 ? 1 : -1);
  };
  modeButton.addEventListener('click', () => {
    twoPlayers = !twoPlayers;
    describe();
    restart();
    canvas.focus();
  });
  describe();

  const onKey = (e: KeyboardEvent, down: boolean) => {
    if (!['KeyW', 'KeyS', 'ArrowUp', 'ArrowDown', 'Space', 'Enter'].includes(e.code)) return;
    e.preventDefault();
    e.stopPropagation();
    if (down) keys.add(e.code);
    else keys.delete(e.code);
  };
  const kd = (e: KeyboardEvent) => onKey(e, true);
  const ku = (e: KeyboardEvent) => onKey(e, false);
  window.addEventListener('keydown', kd, true);
  window.addEventListener('keyup', ku, true);

  const finish = async () => {
    over = true;
    const won = blue.score > red.score;
    if (twoPlayers) return toast(won ? '⚽ ¡Gana el azul!' : '⚽ ¡Gana el rojo!');
    try {
      const { paid } = await nexura<{ paid: number }>('rewards/office', { kind: 'game', game: 'futbolin', result: won ? 'win' : 'loss' });
      await loadWallet();
      toast(won ? `⚽ ¡Has ganado a la máquina!${paid ? ` +${paid} 🪙` : ' (hoy ya no paga más)'}` : '⚽ La máquina gana esta vez');
    } catch (err) {
      toast(`⚽ ${(err as Error).message}`, 'warn');
    }
  };

  const step = (dt: number) => {
    const slide = 260 * dt;
    const limit = 120;
    const p1Up = keys.has('KeyW') || (!twoPlayers && keys.has('ArrowUp'));
    const p1Down = keys.has('KeyS') || (!twoPlayers && keys.has('ArrowDown'));
    blue.offset = Math.max(-limit, Math.min(limit, blue.offset + (p1Down ? slide : 0) - (p1Up ? slide : 0)));
    blue.kick = keys.has('Space') || (!twoPlayers && keys.has('Enter')) ? 1 : 0;
    if (twoPlayers) {
      red.offset = Math.max(-limit, Math.min(limit, red.offset + (keys.has('ArrowDown') ? slide : 0) - (keys.has('ArrowUp') ? slide : 0)));
      red.kick = keys.has('Enter') ? 1 : 0;
    } else {
      // The machine: its nearest man follows the ball, not quite as fast as you can.
      const near = men('red', red.offset).filter((m) => m.x > ball.x - 10).sort((a, b) => Math.abs(a.x - ball.x) - Math.abs(b.x - ball.x))[0];
      const want = near ? red.offset + (ball.y - near.y) : 0;
      red.offset = Math.max(-limit, Math.min(limit, red.offset + Math.max(-slide * 0.8, Math.min(slide * 0.8, want - red.offset))));
      red.kick = Math.abs(ball.x - (near?.x ?? 0)) < 40 && ball.vx > -50 ? 1 : 0;
    }
    if (over) return;
    if (paused > 0) {
      paused -= dt;
      return;
    }
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    if (ball.y < BALL_R || ball.y > H - BALL_R) {
      ball.vy *= -1;
      ball.y = Math.max(BALL_R, Math.min(H - BALL_R, ball.y));
    }
    const inGoal = Math.abs(ball.y - H / 2) < GOAL / 2;
    if (ball.x < BALL_R || ball.x > W - BALL_R) {
      if (inGoal) {
        const scorer = ball.x < W / 2 ? red : blue;
        scorer.score++;
        if (scorer.score >= GOALS_TO_WIN) void finish();
        else reset(scorer === blue ? -1 : 1);
        return;
      }
      ball.vx *= -1;
      ball.x = Math.max(BALL_R, Math.min(W - BALL_R, ball.x));
    }
    for (const [side, team, dir] of [['blue', blue, 1], ['red', red, -1]] as const) {
      for (const m of men(side, team.offset)) {
        if (Math.abs(ball.x - m.x) < MAN.w / 2 + BALL_R && Math.abs(ball.y - m.y) < MAN.h / 2 + BALL_R) {
          const speed = Math.min(720, Math.hypot(ball.vx, ball.vy) * 1.05 + (team.kick ? 260 : 60));
          const angle = ((ball.y - m.y) / (MAN.h / 2 + BALL_R)) * 0.9;
          ball.vx = Math.cos(angle) * speed * dir;
          ball.vy = Math.sin(angle) * speed;
          ball.x = m.x + dir * (MAN.w / 2 + BALL_R + 1);
        }
      }
    }
  };

  const draw = () => {
    g.fillStyle = '#2d6a4f';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,.6)';
    g.lineWidth = 3;
    g.strokeRect(4, 4, W - 8, H - 8);
    g.beginPath();
    g.moveTo(W / 2, 4);
    g.lineTo(W / 2, H - 4);
    g.stroke();
    g.beginPath();
    g.arc(W / 2, H / 2, 50, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#f8f9fa';
    g.fillRect(0, H / 2 - GOAL / 2, 6, GOAL);
    g.fillRect(W - 6, H / 2 - GOAL / 2, 6, GOAL);
    for (const [side, team, color] of [['blue', blue, '#4361ee'], ['red', red, '#e63946']] as const) {
      for (const rod of RODS) {
        const x = side === 'blue' ? rod.x : W - rod.x;
        g.fillStyle = '#adb5bd';
        g.fillRect(x - 2, 0, 4, H);
      }
      g.fillStyle = color;
      for (const m of men(side, team.offset)) g.fillRect(m.x - MAN.w / 2 - (team.kick ? 3 : 0), m.y - MAN.h / 2, MAN.w + (team.kick ? 6 : 0), MAN.h);
    }
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
    g.fill();
    if (over) {
      g.fillStyle = 'rgba(0,0,0,.55)';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#fff';
      g.font = '900 40px Nunito, system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(blue.score > red.score ? (twoPlayers ? '¡Gana el azul!' : '¡Has ganado!') : twoPlayers ? '¡Gana el rojo!' : 'Gana la máquina', W / 2, H / 2);
      g.font = '700 18px Nunito, system-ui, sans-serif';
      g.fillText('Pulsa «Otra partida» para jugar de nuevo', W / 2, H / 2 + 34);
      g.textAlign = 'left';
    }
    score.replaceChildren(h('b', {}, `🔵 ${blue.score}`), h('span.grow', { style: 'text-align:center' }, twoPlayers ? 'Azul contra rojo' : 'Tú contra la máquina'), h('b', {}, `${red.score} 🔴`));
  };

  let last = performance.now();
  let raf = 0;
  const loop = (now: number) => {
    step(Math.min(0.05, (now - last) / 1000));
    last = now;
    draw();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  restart();

  const again = h('button.btn.primary', { type: 'button', onclick: () => (restart(), canvas.focus()) }, '⚽ Otra partida');
  const el = h('div.modal.nx-win', { role: 'dialog', 'aria-label': 'Futbolín', style: 'width:min(780px,100%)' }, h('header', {}, h('h2', {}, '⚽ Futbolín')), h('div.body', {}, score, canvas, help, h('div.nx-actions', {}, again, modeButton)));
  openModal(el, {
    doing: '⚽ jugando al futbolín',
    onClose: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', kd, true);
      window.removeEventListener('keyup', ku, true);
    },
  });
}
