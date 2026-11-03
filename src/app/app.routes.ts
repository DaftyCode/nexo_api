import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: 'workspace',
    loadComponent: () => import('./presentation/workspace').then((m) => m.Workspace),
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
