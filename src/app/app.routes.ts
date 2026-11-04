import { Routes } from '@angular/router';
import { templateStyles } from './presentation/template-styles';

export const routes: Routes = [
  {
    path: 'workspace',
    loadComponent: () => import('./presentation/workspace').then((m) => m.Workspace),
    resolve: { styles: templateStyles },
    title: 'Workspace · Nexo API',
  },
  {
    path: 'docs',
    loadComponent: () => import('./presentation/home').then((m) => m.Home),
    data: { page: 'docs' },
    title: 'Documentation · Nexo API',
  },
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./presentation/home').then((m) => m.Home),
    title: 'Nexo API · Your APIs. Your workspace.',
  },
  { path: '**', redirectTo: '' },
];
