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
  { path: "**", redirectTo: "" },
];
