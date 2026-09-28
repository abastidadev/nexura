import { DestroyRef, effect, inject, Service, signal } from "@angular/core";
import { TitleStrategy, type RouterStateSnapshot } from "@angular/router";
import { readStorage, writeStorage } from "./storage";

const SOUND_KEY = "nexura.sound";
const BLINK_MS = 1200;
const BADGE_PX = 32;

/**
 * Route titles as a signal, so that the "(n)" of what waits for the user is composed on
 * top of them instead of being overwritten by the router on every navigation.
 */
@Service()
export class NexuraTitleStrategy extends TitleStrategy {
  public readonly base = signal(document.title);

  public override updateTitle(snapshot: RouterStateSnapshot): void {
    const title = this.buildTitle(snapshot);
    if (title !== undefined) {
      this.base.set(title);
    }
  }
}

export type Chime = "ok" | "warn" | "err";

/** Notes (Hz) of each chime: rising when done, flat when waiting, falling when it failed. */
const CHIMES: Record<Chime, number[]> = { ok: [659.25, 987.77], warn: [587.33, 587.33], err: [440, 329.63] };

/**
 * What reaches the user outside the page: a short chime (Web Audio, no file), the tab title
 * blinking while Nexura is in the background, and a count badge on the favicon.
 */
@Service()
export class Notifier {
  private readonly titles = inject(NexuraTitleStrategy);
  private audio?: AudioContext;
  private favicon?: { link: HTMLLinkElement; href: string; type: string; image?: HTMLImageElement };
  private readonly flash = signal<string | null>(null);
  private readonly blinkOn = signal(false);

  public readonly soundEnabled = signal<boolean>(readStorage<boolean>(SOUND_KEY, true));
  /** Things waiting for the user: "(n)" in the tab title and a badge on the favicon. */
  public readonly attention = signal(0);

  public constructor() {
    effect(() => writeStorage(SOUND_KEY, this.soundEnabled()));
    effect(() => {
      const count = this.attention();
      const flash = this.flash();
      const plain = `${count ? `(${count}) ` : ""}${this.titles.base()}`;
      document.title = flash && this.blinkOn() ? flash : plain;
    });
    effect(() => this.paintBadge(this.attention()));

    const blink = setInterval(() => {
      if (this.flash()) {
        this.blinkOn.update((on) => !on);
      }
    }, BLINK_MS);
    const back = (): void => {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        this.flash.set(null);
        this.blinkOn.set(false);
      }
    };
    // Browsers only let a page make sound once the user has interacted with it.
    const unlock = (): void => void this.context()?.resume().catch(() => undefined);
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(blink);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
      void this.audio?.close();
    });
  }

  /** The page is behind other windows or tabs: a notification of the system is worth it. */
  public inBackground(): boolean {
    return document.visibilityState !== "visible" || !document.hasFocus();
  }

  /** Chime (if on) and, while Nexura is not in front, a blinking tab title until the user comes back. */
  public alert(chime: Chime, flash: string): void {
    if (this.soundEnabled()) {
      this.play(chime);
    }
    if (this.inBackground()) {
      this.flash.set(flash);
      this.blinkOn.set(true);
    }
  }

  public toggleSound(): void {
    this.soundEnabled.update((enabled) => !enabled);
    if (this.soundEnabled()) {
      this.play("ok");
    }
  }

  public play(chime: Chime): void {
    const context = this.context();
    if (!context) {
      return;
    }
    context
      .resume()
      .then(() => {
        const start = context.currentTime + 0.02;
        CHIMES[chime].forEach((frequency, index) => {
          const at = start + index * 0.15;
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = "sine";
          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(0.2, at + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
          oscillator.connect(gain).connect(context.destination);
          oscillator.start(at);
          oscillator.stop(at + 0.5);
        });
      })
      .catch(() => undefined); // Not unlocked yet: silence rather than an error.
  }

  /** A trophy: a quick rising arpeggio with a bright shimmer on top, like a console's. */
  public playTrophy(): void {
    const context = this.context();
    if (!context) {
      return;
    }
    context
      .resume()
      .then(() => {
        const start = context.currentTime + 0.02;
        const note = (frequency: number, at: number, length: number, type: OscillatorType, peak: number): void => {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = type;
          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(peak, at + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
          oscillator.connect(gain).connect(context.destination);
          oscillator.start(at);
          oscillator.stop(at + length + 0.05);
        };
        // G5 C6 E6 G6, then the chord rings with a high sparkle over it.
        [783.99, 1046.5, 1318.51, 1567.98].forEach((frequency, index) => note(frequency, start + index * 0.07, 0.35, "triangle", 0.16));
        [1046.5, 1318.51, 1567.98].forEach((frequency) => note(frequency, start + 0.3, 0.9, "sine", 0.07));
        note(3135.96, start + 0.34, 0.5, "sine", 0.03);
      })
      .catch(() => undefined);
  }

  private context(): AudioContext | undefined {
    if (!this.audio && typeof AudioContext !== "undefined") {
      try {
        this.audio = new AudioContext();
      } catch {
        return undefined;
      }
    }
    return this.audio;
  }

  /** The favicon with a red count in its corner, or the original one when nothing waits. */
  private paintBadge(count: number): void {
    const link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
    if (!link) {
      return;
    }
    this.favicon ??= { link, href: link.href, type: link.type };
    const favicon = this.favicon;
    if (count === 0) {
      favicon.link.type = favicon.type;
      favicon.link.href = favicon.href;
      return;
    }
    const draw = (image?: HTMLImageElement): void => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = BADGE_PX;
      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }
      if (image) {
        context.drawImage(image, 0, 0, BADGE_PX, BADGE_PX);
      }
      const radius = BADGE_PX * 0.3;
      context.fillStyle = "#e5484d";
      context.beginPath();
      context.arc(BADGE_PX - radius, radius, radius, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#ffffff";
      context.font = `bold ${Math.round(radius * 1.4)}px sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(count > 9 ? "9+" : String(count), BADGE_PX - radius, radius + 1);
      favicon.link.type = "image/png";
      favicon.link.href = canvas.toDataURL("image/png");
    };
    if (favicon.image) {
      draw(favicon.image);
      return;
    }
    const image = new Image();
    image.onload = () => {
      favicon.image = image;
      if (this.attention() === count) {
        draw(image);
      }
    };
    image.onerror = () => draw();
    image.src = favicon.href;
  }
}
