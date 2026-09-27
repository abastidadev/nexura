import { provideHttpClient, withFetch } from "@angular/common/http";
import { type ApplicationConfig, provideBrowserGlobalErrorListeners } from "@angular/core";
import { provideRouter, TitleStrategy, withComponentInputBinding } from "@angular/router";
import { routes } from "./app.routes";
import { NexuraTitleStrategy } from "./core/notifier";

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withFetch()),
    provideRouter(routes, withComponentInputBinding()),
    { provide: TitleStrategy, useExisting: NexuraTitleStrategy },
  ],
};
