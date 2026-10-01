import type { Routes } from "@angular/router";

export const routes: Routes = [
  {
    path: "",
    title: "Nexura · Panel",
    loadComponent: () => import("./features/dashboard/dashboard").then((m) => m.DashboardPage),
  },
  {
    path: "runs",
    title: "Nexura · Flujos",
    loadComponent: () => import("./features/runs-home/runs-home").then((m) => m.RunsHome),
  },
  { path: "panel", redirectTo: "" },
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
    path: "reviews",
    title: "Nexura · Revisión de PRs",
    loadComponent: () => import("./features/pr-reviews/pr-reviews").then((m) => m.PrReviewsPage),
  },
  {
    path: "tickets",
    title: "Nexura · Tickets",
    loadComponent: () => import("./features/tickets/tickets-page").then((m) => m.TicketsPage),
  },
  {
    path: "ai-setup",
    title: "Nexura · Setup IA",
    loadComponent: () => import("./features/ai-setup/ai-setup-page").then((m) => m.AiSetupPage),
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
    path: "office-3d",
    title: "Nexura · Oficina 3D",
    loadComponent: () => import("./features/office-3d/office-3d").then((m) => m.Office3DPage),
  },
  {
    path: "achievements",
    title: "Nexura · Logros",
    loadComponent: () => import("./features/achievements/achievements").then((m) => m.AchievementsPage),
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
