/** An OpenAPI definition with what the backend answers about it, for the tests of its panel. */

import { ApiDiff, ApiInspection } from '../domain/api-definitions';

export const source = 'openapi: 3.0.0\ninfo:\n  title: Shop\npaths:\n  /orders:\n    get: {}\n';
export const inspection: ApiInspection = {
  version: '3.0',
  findings: [
    { severity: 'error', rule: 'info-version', params: [], pointer: '/info', line: 2 },
    {
      severity: 'warning',
      rule: 'operation-summary',
      params: ['GET /orders'],
      pointer: '/paths/~1orders/get',
      line: 6,
    },
    { severity: 'info', rule: 'ref-external', params: ['other.yaml'], pointer: '/x' },
  ],
  outline: {
    title: 'Shop',
    version: '',
    paths: [
      {
        path: '/orders',
        pointer: '/paths/~1orders',
        line: 5,
        operations: [
          {
            method: 'get',
            operationId: 'listOrders',
            summary: '',
            deprecated: true,
            pointer: '/paths/~1orders/get',
            line: 6,
            parameters: [
              {
                name: 'status',
                in: 'query',
                required: true,
                type: 'string',
                pointer: '/p',
                line: 4,
              },
            ],
            requestBody: {
              required: true,
              media: ['application/json'],
              schema: 'Order',
              pointer: '/b',
              line: 3,
            },
            responses: [
              { status: '200', description: 'OK', schema: 'Order[]', pointer: '/r', line: 6 },
            ],
          },
        ],
      },
      {
        path: '/users',
        pointer: '/paths/~1users',
        operations: [
          {
            method: 'post',
            operationId: '',
            summary: 'Add a user',
            deprecated: false,
            pointer: '/u',
            parameters: [],
            requestBody: null,
            responses: [],
          },
        ],
      },
    ],
    schemas: [{ name: 'Order', type: 'object', pointer: '/components/schemas/Order', line: 1 }],
  },
};
export const diff: ApiDiff = {
  breaking: 2,
  removed: [{ method: 'delete', path: '/orders/{id}', pointer: '/d', line: 9 }],
  added: [{ method: 'put', path: '/orders/{id}', pointer: '/a', line: 3 }],
  changed: [
    {
      method: 'get',
      path: '/orders',
      pointer: '/g',
      line: 5,
      changes: [
        {
          rule: 'parameter-added-required',
          params: ['query', 'customer'],
          breaking: true,
          pointer: '/c',
          side: 'source',
          line: 4,
        },
        {
          rule: 'response-removed',
          params: ['404'],
          breaking: false,
          pointer: '/o',
          side: 'base',
          line: 7,
        },
      ],
    },
  ],
};
