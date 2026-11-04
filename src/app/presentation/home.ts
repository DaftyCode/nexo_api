import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Meta } from '@angular/platform-browser';
import { LanguageSelector } from './language-selector';

@Component({
  imports: [TranslocoPipe, RouterLink, LanguageSelector],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-home',
  styleUrl: './home.scss',
  templateUrl: './home.html',
})
export class Home {
  protected readonly docs = inject(ActivatedRoute).snapshot.data['page'] === 'docs';
  constructor() {
    inject(Meta).updateTag({
      name: 'description',
      content:
        'Build, test and organize APIs in your local desktop workspace or on your own server. HTTP, GraphQL, gRPC, WebSocket, MQTT and portable collections.',
    });
  }
}
