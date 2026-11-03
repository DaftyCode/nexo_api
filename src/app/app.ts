import { Component, ChangeDetectionStrategy, afterNextRender, inject } from '@angular/core';
import { RouterOutlet, Router } from '@angular/router';

@Component({
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  private readonly router = inject(Router);
  constructor() {
    afterNextRender(() => {
      if ('__TAURI_INTERNALS__' in window && location.pathname === '/')
        void this.router.navigateByUrl('/workspace');
    });
  }
}
