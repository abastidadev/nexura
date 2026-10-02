// Every HTTP route the office answers, in the order they're tried: a new route goes where it has to
// come in that order (see http/router.ts). The public ones are tried first, then the sign-in check,
// then the rest; the last one answers every path left with the client bundle, or a 404.
import type { Route } from '../router.js';
import { agentRoutes } from './agents.js';
import { authRoutes } from './auth.js';
import { fileRoutes } from './files.js';
import { githubRoutes } from './github.js';
import { pageRoutes } from './pages.js';
import { searchRoutes } from './search.js';
import { nexuraRoutes } from '../../nexura/routes.js'; // nexura

export const routes: readonly Route[] = [
  // Anyone.
  authRoutes.login,
  authRoutes.loginOptions,
  authRoutes.join,
  authRoutes.claimable,
  authRoutes.claim,
  authRoutes.link,
  authRoutes.logout,
  pageRoutes.health,
  pageRoutes.assets,
  pageRoutes.login,
  pageRoutes.claim,
  pageRoutes.join,
  pageRoutes.favicon,
  nexuraRoutes.workers, // nexura
  // Signed in.
  authRoutes.whoami,
  agentRoutes.openCodeModels,
  agentRoutes.grokModels,
  fileRoutes.image,
  fileRoutes.whiteboardFile,
  fileRoutes.termDrop,
  fileRoutes.changedFile,
  fileRoutes.docs,
  searchRoutes.search,
  githubRoutes.github,
  nexuraRoutes.achievements, // nexura
  nexuraRoutes.open, // nexura
  nexuraRoutes.proxy, // nexura: after the two above, which it would answer too
  pageRoutes.office,
  pageRoutes.lite,
  pageRoutes.bundle,
];
