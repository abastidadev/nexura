import { randomUUID } from "node:crypto";
import type { TriviaQuestion } from "@nexura/shared";
import { git } from "../workspace/git.ts";

/** A question and its answer, which only the server knows until it's answered. */
export type TriviaCard = { question: TriviaQuestion; answer: string };

type Commit = { author: string; year: string; subject: string; files: string[] };

/** The last `limit` commits of a repo: author, year, subject and the files each touched. */
async function commits(path: string, limit: number): Promise<Commit[]> {
  const out = await git(path, ["log", `-n${limit}`, "--no-merges", "--name-only", "--format=\u001e%an\u001f%ad\u001f%s", "--date=format:%Y"]);
  return out
    .split("\u001e")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const [head = "", ...files] = block.split("\n");
      const [author = "", year = "", subject = ""] = head.split("\u001f");
      return { author, year, subject, files: files.map((file) => file.trim()).filter(Boolean) };
    });
}

function shuffle<T>(list: T[], random: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The `n` most frequent values, most frequent first. */
function top(values: string[], n: number): string[] {
  const count = new Map<string, number>();
  for (const value of values) count.set(value, (count.get(value) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([value]) => value);
}

function card(repo: string, question: string, answer: string, wrong: string[], random: () => number): TriviaCard | undefined {
  const options = [...new Set([answer, ...wrong.filter((option) => option !== answer)])].slice(0, 4);
  if (options.length < 2) return undefined;
  return { question: { id: randomUUID(), repo, question, options: shuffle(options, random) }, answer };
}

/** Each kind of question, made from a repo's recent history; undefined when the history can't make it. */
const KINDS: ((repo: string, log: Commit[], random: () => number) => TriviaCard | undefined)[] = [
  // Who touched a file last.
  (repo, log, random) => {
    const authors = [...new Set(log.map((c) => c.author))];
    const pick = shuffle(log.filter((c) => c.files.length), random)[0];
    const file = pick ? shuffle(pick.files, random)[0] : undefined;
    if (!pick || !file || authors.length < 2) return undefined;
    const last = log.find((c) => c.files.includes(file))!;
    return card(repo, `¿Quién fue la última persona en tocar \`${file}\`?`, last.author, shuffle(authors, random), random);
  },
  // The file that changes the most.
  (repo, log, random) => {
    const files = top(log.flatMap((c) => c.files), 12);
    if (files.length < 4) return undefined;
    return card(repo, "¿Qué fichero ha cambiado más en los últimos commits?", files[0]!, shuffle(files.slice(1), random), random);
  },
  // The busiest author.
  (repo, log, random) => {
    const authors = top(log.map((c) => c.author), 6);
    if (authors.length < 2) return undefined;
    return card(repo, "¿Quién ha hecho más commits últimamente?", authors[0]!, shuffle(authors.slice(1), random), random);
  },
  // Which commit message is real (the others come from other files' commits, reworded).
  (repo, log, random) => {
    const subjects = [...new Set(log.map((c) => c.subject).filter((s) => s.length > 8))];
    if (subjects.length < 4) return undefined;
    const real = shuffle(subjects, random)[0]!;
    const commit = log.find((c) => c.subject === real)!;
    const others = shuffle(subjects.filter((s) => s !== real), random);
    return card(repo, `¿Qué mensaje de commit es de ${commit.author}?`, real, others.filter((s) => log.find((c) => c.subject === s)?.author !== commit.author), random);
  },
  // When a file was last touched (year).
  (repo, log, random) => {
    const oldest = log.at(-1);
    if (!oldest || !/^\d{4}$/.test(oldest.year)) return undefined;
    const year = Number(oldest.year);
    const wrong = [year - 2, year - 1, year + 1].map(String);
    return card(repo, `¿En qué año se hizo el commit «${oldest.subject}»?`, oldest.year, shuffle(wrong, random), random);
  },
];

/** A trivia question about one of `repos`, from its last 300 commits. Undefined when none has enough history. */
export async function makeTrivia(repos: { name: string; path: string }[], random: () => number = Math.random): Promise<TriviaCard | undefined> {
  for (const repo of shuffle(repos, random)) {
    let log: Commit[];
    try {
      log = await commits(repo.path, 300);
    } catch {
      continue;
    }
    if (log.length < 3) continue;
    for (const kind of shuffle(KINDS, random)) {
      const made = kind(repo.name, log, random);
      if (made) return made;
    }
  }
  return undefined;
}
