// nexura: approving a flow from its desk. A flow paused for you (a step to confirm, its PR to open, or
// replies to post on its PR) can go on from the office as Nexura proposed it, or skip that step;
// changing what it proposes is done in Nexura, which opens with one button.
import type { WorkerInfo } from '../../shared/protocol';
import { h, openModal, toast } from '../ui/dom';
import { flowOf, loadDigest, type DigestFlow } from './digest';
import { nexura } from './wallet';

const WAITING: Record<NonNullable<DigestFlow['waiting']>, { title: string; go: string; skip: string; about: string }> = {
  step: { title: 'Confirmar el siguiente paso', go: '▶ Continuar', skip: '⏭ Saltar este paso', about: 'El flujo va paso a paso y espera tu visto bueno para seguir.' },
  pr: { title: 'Aprobar la PR', go: '✅ Abrir la PR tal cual', skip: '🌿 Dejar la rama en local', about: 'El flujo terminó y espera para hacer push y abrir la PR con el borrador que ha escrito.' },
  replies: { title: 'Responder a la revisión', go: '💬 Publicar las respuestas', skip: '⏭ No responder', about: 'El flujo atendió los comentarios de la PR y tiene respuestas listas para publicar.' },
};

/** What P says at a flow's desk, when it's waiting for you. */
export function approveLabel(w: WorkerInfo): string | undefined {
  const waiting = w.external && flowOf(w.external.runId)?.waiting;
  return waiting ? (waiting === 'pr' ? 'Aprobar PR' : waiting === 'replies' ? 'Responder' : 'Continuar') : undefined;
}

/** The approval window for a flow waiting at its desk; false when it isn't waiting (the caller opens the run instead). */
export function openApprove(w: WorkerInfo, openRun: () => void): boolean {
  const flow = w.external && flowOf(w.external.runId);
  if (!flow?.waiting) return false;
  const what = WAITING[flow.waiting];
  const status = h('p.nx-muted', { role: 'status' });
  const send = async (skip: boolean, button: HTMLButtonElement) => {
    button.disabled = true;
    status.textContent = 'Enviando a Nexura…';
    try {
      await nexura(`runs/${flow.runId}/continue`, { skip });
      toast(skip ? `⏭ ${flow.name}: paso saltado` : `▶ ${flow.name} sigue adelante`);
      modal.close();
      void loadDigest();
    } catch (err) {
      status.textContent = `⚠️ ${(err as Error).message}`;
      button.disabled = false;
    }
  };
  const go = h('button.btn.primary', { type: 'button' }, what.go);
  const skip = h('button.btn', { type: 'button' }, what.skip);
  go.addEventListener('click', () => void send(false, go));
  skip.addEventListener('click', () => void send(true, skip));
  const steps = flow.steps.map((s) => h('span.nx-pill', { class: s.status === 'succeeded' ? 'ok' : s.status === 'running' ? 'run' : s.status === 'failed' ? 'bad' : s.step === flow.current ? 'wait' : '' }, s.step));
  const el = h(
    'div.modal.nx-win',
    { role: 'dialog', 'aria-label': what.title },
    h('header', {}, h('h2', {}, `${flow.name} · ${what.title}`)),
    h(
      'div.body',
      {},
      h('div.nx-row', {}, h('span.grow', {}, flow.title), h('span.nx-pill', {}, `$${flow.costUsd.toFixed(2)}`)),
      h('div.nx-actions', {}, ...steps),
      h('p', {}, what.about),
      h('div.nx-actions', {}, go, skip, h('button.btn', { type: 'button', onclick: () => (modal.close(), openRun()) }, '↗ Revisar en Nexura')),
      status,
    ),
  );
  const modal = openModal(el, { doing: `✅ aprobando ${flow.name}` });
  return true;
}
