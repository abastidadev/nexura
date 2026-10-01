// nexura: the first time you come into the office with Nexura, a short tour of what Nexura added: the
// coins and the shop, the control room, the mailbox, the game room and the palette. Each stop can walk
// you there. It shows once per browser; the palette brings it back ("Visita guiada").
import { h, openModal } from '../ui/dom';
import type { Interactable } from '../world/types';
import { thingOf } from './things';
import { wallet } from './wallet';

const SEEN = 'nexura.tour';

type WalkThen = (it: Interactable, what: string, then: () => void) => void;

const STOPS: { icon: string; title: string; text: string; id?: string; what?: string }[] = [
  { icon: '🪙', title: 'Tus monedas', text: 'Nexura te paga monedas por tu trabajo (flujos, PR integradas, revisiones, logros) y por jugar aquí. Las tienes arriba a la izquierda.' },
  { icon: '🛍️', title: 'La tienda', text: 'Junto al ascensor. Cambia cada día: sombreros, mascotas, estelas… y salas y juegos que se desbloquean.', id: 'shop', what: 'the shop' },
  { icon: '🛰️', title: 'La sala de control', text: 'Los flujos de Nexura en marcha, paso a paso. Desde aquí, o con P en su mesa, apruebas los que te esperan.', id: 'control', what: 'the control room' },
  { icon: '📮', title: 'El buzón', text: 'Coge una tarjeta del tablero de Issues y suéltala aquí para abrir un flujo nuevo en Nexura.', id: 'inbox', what: 'the mailbox' },
  { icon: '🎮', title: 'La sala de juegos', text: 'Futbolín, Trivial del repo y el Gran Premio, donde apuestas por qué flujo termina antes. Se compran en la tienda.', id: 'futbolin', what: 'the game room' },
  { icon: '🦆', title: 'Los patitos', text: 'Cinco patitos de goma se esconden por la oficina y cambian de sitio cada lunes. Cada uno paga monedas.' },
  { icon: '⌨️', title: 'Ctrl+K', text: 'La paleta encuentra todo esto (y lo demás de la oficina) con unas letras.' },
];

export function openTour(interactables: readonly Interactable[], walkThen: WalkThen): void {
  let i = 0;
  const body = h('div.body');
  const render = () => {
    const stop = STOPS[i]!;
    const it = stop.id ? interactables.find((x) => x.nexura === stop.id) : undefined;
    body.replaceChildren(
      h('div.nx-row', {}, h('span.nx-big', {}, stop.icon), h('span.grow', { style: 'white-space:normal' }, h('b', {}, stop.title), h('br'), stop.text)),
      h(
        'div.nx-actions',
        {},
        i > 0 ? h('button.btn', { type: 'button', onclick: () => (i--, render()) }, '← Atrás') : '',
        it ? h('button.btn', { type: 'button', onclick: () => (modal.close(), walkThen(it, stop.what!, () => thingOf(it)?.use(it, 'E'))) }, '🚶 Llévame') : '',
        i < STOPS.length - 1 ? h('button.btn.primary', { type: 'button', onclick: () => (i++, render()) }, 'Siguiente →') : h('button.btn.primary', { type: 'button', onclick: () => modal.close() }, '¡A trabajar!'),
      ),
      h('p.nx-muted', {}, `${i + 1} de ${STOPS.length}${wallet() ? ` · tienes 🪙 ${wallet()!.coins}` : ''}`),
    );
  };
  render();
  const modal = openModal(h('div.modal.nx-win', { role: 'dialog', 'aria-label': 'Visita guiada' }, h('header', {}, h('h2', {}, '👋 Bienvenida a la oficina de Nexura')), body), { doing: '👋 haciendo la visita guiada' });
  try {
    localStorage.setItem(SEEN, '1');
  } catch {
    // no storage: it shows again next time
  }
}

/** The tour, once per browser, a moment after you're in (and only with Nexura there). */
export function maybeTour(interactables: () => readonly Interactable[], walkThen: WalkThen): void {
  try {
    if (localStorage.getItem(SEEN)) return;
  } catch {
    return;
  }
  setTimeout(() => {
    if (wallet() && !document.querySelector('.modal')) openTour(interactables(), walkThen);
  }, 4000);
}
