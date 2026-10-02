// nexura: a flat screen or sign whose picture is drawn on a canvas and redrawn when its data changes:
// the control room's monitors, the boards, the vending machine's display.
import * as THREE from 'three';

export interface Panel {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** Redraws it; `key` skips the work when nothing it shows changed. */
  draw(key: string, paint: (g: CanvasRenderingContext2D, w: number, h: number) => void): void;
}

/** A `width` × `height` meter panel at `px` pixels per meter, facing +z. */
export function panel(width: number, height: number, px = 220): Panel {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * px);
  canvas.height = Math.round(height * px);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  let shown = '';
  return {
    mesh,
    draw(key, paint) {
      if (key === shown) return;
      shown = key;
      const g = canvas.getContext('2d')!;
      g.clearRect(0, 0, canvas.width, canvas.height);
      paint(g, canvas.width, canvas.height);
      tex.needsUpdate = true;
    },
  };
}

/** Text that stops at `max` pixels wide, with an ellipsis. */
export function fit(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

export const FONT = 'Nunito, ui-rounded, system-ui, sans-serif';
