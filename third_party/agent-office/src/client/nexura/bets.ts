// nexura: betting coins on Nexura's flows. The porra: will a flow get through review and QA without
// going back to implement? Right doubles the stake. The Grand Prix (a game of the shop): which of the
// flows running now finishes first? Right pays the stake times the runners. Nexura keeps the bets and
// settles them as the flows end (apps/server/src/rewards).
import { h, openModal, toast } from '../ui/dom';
import { currentDigest, type DigestFlow } from './digest';
import { loadWallet, nexura, owns, wallet } from './wallet';

const STAKES = [10, 20, 50, 100, 200];

function stakePicker(): { el: HTMLElement; value: () => number } {
  let stake = 20;
  const buttons = STAKES.map((n) => {
    const b = h('button.nx-shop-piece', { type: 'button', class: n === stake ? 'on' : '' }, `🪙 ${n}`);
    b.addEventListener('click', () => {
      stake = n;
      buttons.forEach((x, i) => x.classList.toggle('on', STAKES[i] === n));
    });
    return b;
  });
  return { el: h('div.nx-actions', {}, ...buttons), value: () => stake };
}

async function place(kind: 'first-try' | 'retry' | 'race', runId: string, stake: number, done: () => void, status: HTMLElement) {
  status.textContent = 'Apostando…';
  try {
    await nexura('rewards/bets', { kind, runId, stake });
    await loadWallet();
    toast(`🎲 Apuesta hecha: 🪙 ${stake}`);
    done();
  } catch (err) {
    status.textContent = `⚠️ ${(err as Error).message}`;
  }
}

/** The porra on one flow. */
export function openPorra(flow: DigestFlow): void {
  const open = wallet()?.bets.find((b) => b.status === 'open' && b.runId === flow.runId && b.kind !== 'race');
  const stake = stakePicker();
  const status = h('p.nx-muted', { role: 'status' });
  const closed = flow.steps.some((s) => ['codeReview', 'qaCode', 'release'].includes(s.step));
  const body = open
    ? h('p.nx-locked', {}, `Ya apostaste 🪙 ${open.stake} a que ${open.kind === 'first-try' ? 'pasa a la primera' : 'vuelve a implementar'}.`)
    : closed
      ? h('p.nx-locked', {}, 'La porra de este flujo ya está cerrada: ya llegó a revisión o QA.')
      : h(
          'div',
          {},
          h('p', {}, '¿Pasará la revisión y QA sin volver a implementar? Si aciertas, cobras el doble. Si el flujo no termina, te devuelven la apuesta.'),
          stake.el,
          h(
            'div.nx-actions',
            {},
            h('button.btn.primary', { type: 'button', onclick: () => void place('first-try', flow.runId, stake.value(), () => modal.close(), status) }, '🎯 A la primera'),
            h('button.btn', { type: 'button', onclick: () => void place('retry', flow.runId, stake.value(), () => modal.close(), status) }, '🔁 Vuelve a implementar'),
          ),
          status,
        );
  const el = h('div.modal.nx-win', { role: 'dialog', 'aria-label': 'Porra' }, h('header', {}, h('h2', {}, `🎲 Porra · ${flow.name}`)), h('div.body', {}, h('div.nx-row', {}, h('span.grow', {}, flow.title), h('span.nx-pill', {}, `🪙 ${wallet()?.coins ?? '?'}`)), body));
  const modal = openModal(el, { doing: '🎲 apostando' });
}

/** The Grand Prix: bet on which running flow finishes first. */
export function openRaceBet(onBet?: () => void): void {
  const flows = currentDigest()?.active ?? [];
  const open = wallet()?.bets.find((b) => b.status === 'open' && b.kind === 'race');
  const stake = stakePicker();
  const status = h('p.nx-muted', { role: 'status' });
  let body: HTMLElement;
  if (!owns('game-race')) body = h('p.nx-locked', {}, '🔒 El Gran Premio se compra en la tienda de Nexura.');
  else if (open) body = h('p.nx-locked', {}, `Ya apostaste 🪙 ${open.stake} por ${flows.find((f) => f.runId === open.runId)?.name ?? 'un flujo'}. ¡A ver quién llega antes!`);
  else if (flows.length < 2) body = h('p.nx-locked', {}, 'Hacen falta al menos dos flujos en marcha para una carrera. Lanza otro en Nexura.');
  else
    body = h(
      'div',
      {},
      h('p', {}, `¿Qué flujo termina primero? Si aciertas, cobras la apuesta × ${flows.length}.`),
      stake.el,
      ...flows.map((f) => h('div.nx-row', {}, h('b', {}, f.name), h('span.grow', {}, f.title), h('span.nx-pill', {}, f.current ?? f.status), h('button.btn.primary', { type: 'button', onclick: () => void place('race', f.runId, stake.value(), () => (modal.close(), onBet?.()), status) }, '🏁 Este'))),
      status,
    );
  const el = h('div.modal.nx-win', { role: 'dialog', 'aria-label': 'Gran Premio' }, h('header', {}, h('h2', {}, '🏎️ Gran Premio de flujos')), h('div.body', {}, body));
  const modal = openModal(el, { doing: '🏎️ en el Gran Premio' });
}
