import type { Routes } from "@angular/router";

export const routes: Routes = [
  {
    path: "",
    title: "Nexura · Flujos",
    loadComponent: () => import("./features/runs-home/runs-home").then((m) => m.RunsHome),
  },
  {
    path: "new",
    title: "Nexura · Nuevo flujo",
    loadComponent: () => import("./features/new-run/new-run").then((m) => m.NewRun),
  },
  {
    path: "runs/:id",
    title: "Nexura · Flujo",
    loadComponent: () => import("./features/run-view/run-view").then((m) => m.RunView),
  },
  {
    path: "terminal",
    title: "Nexura · Terminal",
    loadComponent: () => import("./features/terminal/terminal-page").then((m) => m.TerminalPage),
  },
  {
    path: "agents",
    title: "Nexura · Agentes",
    loadComponent: () => import("./features/agents/agents").then((m) => m.AgentsPage),
  },
  {
    path: "metrics",
    title: "Nexura · Métricas",
    loadComponent: () => import("./features/metrics/metrics").then((m) => m.MetricsPage),
  },
  {
    path: "config",
    title: "Nexura · Configuración",
    loadComponent: () => import("./features/settings/settings").then((m) => m.Settings),
  },
  { path: "**", redirectTo: "" },
];
