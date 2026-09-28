/**
 * Achievements: finished work, good reviews, steady contribution, and a few secrets hidden in the
 * 3D office. The catalog is data only; the server works out progress from what Nexura saw happen
 * (apps/server/src/achievements) and both UIs render what it returns.
 */

export type AchievementTier = "bronze" | "silver" | "gold" | "platinum";

export type AchievementCategory = "tickets" | "reviews" | "constancy" | "office" | "legend";

export const ACHIEVEMENT_TIER_LABELS: Record<AchievementTier, string> = { bronze: "Bronce", silver: "Plata", gold: "Oro", platinum: "Platino" };

export const ACHIEVEMENT_TIER_POINTS: Record<AchievementTier, number> = { bronze: 15, silver: 30, gold: 90, platinum: 180 };

export const ACHIEVEMENT_CATEGORY_LABELS: Record<AchievementCategory, string> = {
  tickets: "Tickets",
  reviews: "Revisiones",
  constancy: "Constancia",
  office: "Oficina 3D",
  legend: "Leyenda",
};

export type AchievementDef = {
  id: string;
  tier: AchievementTier;
  category: AchievementCategory;
  /** One emoji, drawn inside the medal. */
  icon: string;
  title: string;
  /** How to get it (Spanish). Hidden while a secret one is locked. */
  description: string;
  /** Hidden until unlocked: only `hint` shows. */
  secret?: boolean;
  /** What a locked secret one says about itself. */
  hint?: string;
};

export const ACHIEVEMENTS: readonly AchievementDef[] = [
  // ---- Tickets
  { id: "first-mission", tier: "bronze", category: "tickets", icon: "🚀", title: "Primera misión", description: "Resuelve tu primer ticket con un flujo de Nexura." },
  { id: "five-on-board", tier: "bronze", category: "tickets", icon: "🖐️", title: "Cinco en el tablero", description: "Resuelve 5 tickets distintos." },
  { id: "first-merge", tier: "bronze", category: "tickets", icon: "🔀", title: "Directo a main", description: "Consigue que se integre la primera PR abierta por uno de tus flujos." },
  { id: "back-to-workshop", tier: "bronze", category: "tickets", icon: "🔧", title: "De vuelta al taller", description: "Atiende los comentarios de una revisión desde el flujo y consigue que la PR se integre." },
  { id: "ticket-writer", tier: "bronze", category: "tickets", icon: "✍️", title: "Buena letra", description: "Crea un ticket con el asistente de Tickets." },
  { id: "multitask", tier: "bronze", category: "tickets", icon: "🤹", title: "Multitarea", description: "Ten 3 flujos en marcha a la vez." },
  { id: "two-fronts", tier: "bronze", category: "tickets", icon: "🧩", title: "Dos frentes", description: "Resuelve un ticket que toca dos o más repos en el mismo flujo." },
  { id: "full-throttle", tier: "silver", category: "tickets", icon: "⚡", title: "A pleno rendimiento", description: "Resuelve 10 tickets repartidos en al menos 4 semanas distintas." },
  { id: "first-try", tier: "silver", category: "tickets", icon: "🎯", title: "A la primera", description: "Resuelve 10 tickets sin que la revisión ni QA devuelvan el trabajo a implementar." },
  { id: "polyglot", tier: "silver", category: "tickets", icon: "🗣️", title: "Políglota", description: "Termina flujos con los tres agentes: Claude, Codex y Copilot." },
  { id: "board-veteran", tier: "gold", category: "tickets", icon: "🎖️", title: "Veterano del tablero", description: "Resuelve 50 tickets repartidos en al menos 12 semanas." },

  // ---- Reviews
  { id: "sharp-eye", tier: "bronze", category: "reviews", icon: "👁️", title: "Ojo clínico", description: "Publica tu primera revisión de una PR ajena." },
  { id: "constructive", tier: "bronze", category: "reviews", icon: "🧱", title: "Crítica constructiva", description: "Publica una revisión con al menos 3 comentarios, uno de ellos con una sugerencia de código." },
  { id: "second-pair", tier: "silver", category: "reviews", icon: "👓", title: "Segundo par de ojos", description: "Revisa 20 PR distintas repartidas en al menos 6 semanas." },
  { id: "fair-point", tier: "silver", category: "reviews", icon: "⚖️", title: "La observación justa", description: "Consigue que se corrijan 5 problemas señalados en tus revisiones (sin contar los nits)." },
  { id: "note-taker", tier: "silver", category: "reviews", icon: "📓", title: "Tomar nota", description: "Guarda en las notas del repo las convenciones de 3 revisiones." },
  { id: "code-guardian", tier: "gold", category: "reviews", icon: "🛡️", title: "Guardián del código", description: "Revisa 60 PR distintas repartidas en al menos 12 semanas." },
  { id: "real-bug", tier: "gold", category: "reviews", icon: "🐛", title: "Eso sí que era un bug", description: "Consigue que se corrijan 20 problemas señalados en tus revisiones (sin contar los nits)." },

  // ---- Constancy
  { id: "on-a-roll", tier: "bronze", category: "constancy", icon: "🔥", title: "En racha", description: "Resuelve un ticket o publica una revisión 3 días laborables seguidos." },
  { id: "always-here", tier: "silver", category: "constancy", icon: "📅", title: "Siempre por aquí", description: "Aporta un ticket resuelto o una revisión publicada en 8 semanas distintas; no tienen que ser consecutivas." },
  { id: "all-terrain", tier: "gold", category: "constancy", icon: "🚙", title: "Todoterreno", description: "Resuelve 20 tickets y revisa 20 PR, repartidos en al menos 12 semanas." },
  { id: "half-year", tier: "gold", category: "constancy", icon: "🗓️", title: "Medio año en el taller", description: "Aporta un ticket resuelto o una revisión publicada en 26 semanas distintas." },

  // ---- Secrets of the work itself
  { id: "before-prod", tier: "gold", category: "reviews", icon: "🚨", title: "Antes de que llegara a producción", description: "Detecta 3 problemas graves (blocker o major) en PR que se corrigen antes de integrarlas.", secret: true, hint: "Hay errores que es mejor cazar antes de tiempo." },
  { id: "full-chain", tier: "silver", category: "tickets", icon: "⛓️", title: "Cadena completa", description: "Lleva 5 tickets desde su creación en Nexura hasta la PR integrada, con revisión de otra persona.", secret: true, hint: "Del primer borrador a la rama principal, sin soltarlo." },
  { id: "night-owl", tier: "bronze", category: "tickets", icon: "🦉", title: "Búho nocturno", description: "Termina un flujo entre las 00:00 y las 05:00.", secret: true, hint: "Hay flujos que terminan cuando nadie mira." },
  { id: "friday-deploy", tier: "silver", category: "tickets", icon: "🍻", title: "Despliegue en viernes", description: "Consigue que se integre la PR de un flujo un viernes por la tarde.", secret: true, hint: "Dicen que hay un día en que no se integra nada." },
  { id: "phoenix", tier: "silver", category: "tickets", icon: "🦅", title: "Fénix", description: "Termina bien un flujo que había fallado.", secret: true, hint: "Caer no es el final." },

  // ---- The 3D office
  { id: "trophy-room", tier: "bronze", category: "office", icon: "🏆", title: "Sala de trofeos", description: "Mira tus logros en la vitrina de la Oficina 3D." },
  { id: "good-boy", tier: "bronze", category: "office", icon: "🐶", title: "El mejor amigo del dev", description: "Acaricia 10 veces al perro de la oficina." },
  { id: "caffeine", tier: "bronze", category: "office", icon: "☕", title: "Cafeína en vena", description: "Tómate 10 cafés en la oficina." },
  { id: "gong", tier: "bronze", category: "office", icon: "🥁", title: "¡Que suene el gong!", description: "Toca el gong de las integraciones." },
  { id: "dj", tier: "bronze", category: "office", icon: "🎵", title: "Pinchadiscos", description: "Pon música en la jukebox." },
  { id: "insert-coin", tier: "bronze", category: "office", icon: "🕹️", title: "Insert coin", description: "Juega 3 partidas en la recreativa." },
  { id: "firefighter", tier: "bronze", category: "office", icon: "🧯", title: "Bombero", description: "Baja por la barra de bomberos." },
  { id: "tourist", tier: "silver", category: "office", icon: "🧭", title: "Turista", description: "Usa 12 cosas distintas de la oficina." },
  { id: "duck-1", tier: "bronze", category: "office", icon: "🦆", title: "Hay algo en la oficina…", description: "Encuentra un patito de goma escondido en la oficina.", secret: true, hint: "Algo pequeño y amarillo se esconde entre los muebles." },
  { id: "duck-hunter", tier: "gold", category: "office", icon: "🛁", title: "Cazador de patitos", description: "Encuentra los 5 patitos de goma de la oficina.", secret: true, hint: "Cuando encuentres el primero, sabrás qué buscar." },
  { id: "rooftop", tier: "silver", category: "office", icon: "🍹", title: "Con vistas", description: "Sube a la azotea y pide algo en la barra.", secret: true, hint: "Hay una escalera que no lleva a ninguna planta." },
  { id: "hole-in-one", tier: "silver", category: "office", icon: "⛳", title: "Hoyo en uno", description: "Mete la bola de golf desde el balcón de un solo golpe.", secret: true, hint: "Desde el balcón se ve un green." },
  { id: "night-shift", tier: "silver", category: "office", icon: "🌙", title: "Turno de noche", description: "Pasa por la oficina entre las 00:00 y las 05:00.", secret: true, hint: "La oficina de noche es otra cosa." },
  { id: "konami", tier: "gold", category: "office", icon: "🎮", title: "↑↑↓↓←→←→BA", description: "Teclea el código Konami dentro de la oficina.", secret: true, hint: "Hay combinaciones que nunca pasan de moda." },

  // ---- The one above them all
  { id: "nexura-legend", tier: "platinum", category: "legend", icon: "💎", title: "Leyenda de Nexura", description: "Consigue todos los logros de oro." },
];

/** Hidden rubber ducks in the 3D office. */
export const OFFICE_DUCKS = 5;

/** Things of the 3D office whose use it reports (its interactable kinds, plus the trophy case). */
export const OFFICE_USES = [
  "desk", "station", "issues", "pulls", "services", "queue", "tv", "coffee", "decor", "smoke", "elevator", "gong", "dog",
  "jukebox", "seat", "whiteboard", "cabinet", "ladder", "pole", "meeting", "bar", "dj", "golf", "ball", "bookshelf", "trophies",
] as const;

export type OfficeUse = (typeof OFFICE_USES)[number];

/** What the 3D office reports: something used, a duck found, or one of its secrets. */
export type OfficeAchievementEvent =
  | { kind: "use"; what: OfficeUse }
  | { kind: "duck"; duck: number }
  | { kind: "secret"; what: "konami" | "night-shift" | "hole-in-one" };

export type AchievementProgress = {
  current: number;
  goal: number;
  /** A second condition (distinct weeks, the other half of the goal…), e.g. "3/4 semanas". */
  extra?: { current: number; goal: number; label: string };
};

/** One achievement as the UIs show it: secret ones come masked until unlocked. */
export type AchievementView = {
  id: string;
  tier: AchievementTier;
  category: AchievementCategory;
  icon: string;
  title: string;
  description: string;
  secret: boolean;
  unlockedAt?: string;
  /** Unlocked and not yet seen on the Logros page. */
  fresh?: boolean;
  progress?: AchievementProgress;
};

export type AchievementsSummary = {
  achievements: AchievementView[];
  unlocked: number;
  total: number;
  points: number;
  maxPoints: number;
  byTier: Record<AchievementTier, { unlocked: number; total: number }>;
  /** Rubber ducks found in the office (they have their own counter). */
  ducks: number[];
};

/** A level every this many points. */
export const ACHIEVEMENT_LEVEL_POINTS = 100;
