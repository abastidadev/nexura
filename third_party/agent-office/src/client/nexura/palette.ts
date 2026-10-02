// nexura: Nexura's things in the command palette (Ctrl+K), each opened as E at it would, or walked to
// first (Shift+Enter): the shop, the control room, the boards, the games… and Nexura's own pages.
import type { PaletteEntry } from '../ui/palette';
import type { Interactable } from '../world/types';
import { openNexuraPage } from './external';
import { thingOf } from './things';
import { openTour } from './tour';

type WalkThen = (it: Interactable, what: string, then: () => void) => void;

const THINGS: { id: string; icon: string; title: string; what: string; detail?: string; keywords: string[] }[] = [
  { id: 'shop', icon: '🛍️', title: 'Tienda de Nexura', what: 'the shop', detail: 'Gasta tus monedas', keywords: ['shop', 'coins', 'monedas', 'comprar'] },
  { id: 'control', icon: '🛰️', title: 'Sala de control', what: 'the control room', detail: 'Los flujos en marcha', keywords: ['flows', 'flujos', 'runs'] },
  { id: 'reviews', icon: '👁️', title: 'PR por revisar', what: 'the reviews board', keywords: ['review', 'revisiones'] },
  { id: 'today', icon: '📅', title: 'Hoy en Nexura', what: 'the today board', keywords: ['summary', 'resumen', 'métricas'] },
  { id: 'vending', icon: '🥤', title: 'Máquina de cuota', what: 'the quota machine', keywords: ['quota', 'cuota', 'limits'] },
  { id: 'trophies', icon: '🏆', title: 'Vitrina de logros', what: 'the trophy case', keywords: ['achievements', 'logros', 'trophies'] },
  { id: 'fame', icon: '🖼️', title: 'Galería de la fama', what: 'the Hall of Fame', keywords: ['merged', 'fama'] },
  { id: 'inbox', icon: '📮', title: 'Buzón de Nexura', what: 'the mailbox', keywords: ['issue', 'nuevo flujo'] },
  { id: 'futbolin', icon: '⚽', title: 'Futbolín', what: 'the futbolín', keywords: ['game', 'juego', 'football'] },
  { id: 'trivia', icon: '❓', title: 'Trivial del repo', what: 'the trivia cabinet', keywords: ['game', 'juego', 'quiz'] },
  { id: 'race', icon: '🏎️', title: 'Gran Premio de flujos', what: 'the slot-car track', keywords: ['race', 'carrera', 'apuesta'] },
];

export function nexuraPaletteEntries(interactables: readonly Interactable[], walkThen: WalkThen): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const t of THINGS) {
    const it = interactables.find((i) => i.nexura === t.id);
    if (!it) continue;
    const open = () => thingOf(it)?.use(it, 'E');
    out.push({ icon: t.icon, kind: 'Nexura', title: t.title, detail: t.detail, keywords: t.keywords, open, walk: () => walkThen(it, t.what, open) });
  }
  out.push({ icon: '🚀', kind: 'Nexura', title: 'Flujos en Nexura', detail: 'Abre la lista de flujos', keywords: ['runs', 'nuevo flujo'], open: () => openNexuraPage('runs') });
  out.push({ icon: '📊', kind: 'Nexura', title: 'Métricas de Nexura', keywords: ['metrics', 'coste'], open: () => openNexuraPage('metrics') });
  out.push({ icon: '👋', kind: 'Nexura', title: 'Visita guiada de Nexura', keywords: ['tour', 'ayuda', 'help'], open: () => openTour(interactables, walkThen) });
  return out;
}
