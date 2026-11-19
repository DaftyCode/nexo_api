import { mayChangeData, readEnvironmentSettings } from '../../domain/environment-protection';
import { ExecutionResponse } from '../../domain/models';
import { historyRequest, historyResponse } from '../../domain/sanitize';
import { toVariableRows } from '../../domain/variables';
import { realtimeProtocols } from '../state/requests-store';
import { WorkspaceState } from '../workspace-state';

/**
 * Sends the request of the active tab with an environment, which is asked first if it
 * asks before changes (and refuses them if it is read-only). The response goes to the
 * history; the variables its scripts change are not saved.
 */
export async function sendToCompare(
  state: WorkspaceState,
  environmentId: string,
): Promise<ExecutionResponse | undefined> {
  const request = state.active()?.request;
  if (!request) throw new Error('Open the request to send in a tab');
  if (realtimeProtocols.includes(request.protocol))
    throw new Error('Only HTTP and GraphQL requests are sent to compare');
  const environment = state.environments().find((d) => d.id === environmentId);
  const asks = environment && readEnvironmentSettings(environment.value).protection === 'confirm';
  if (
    asks &&
    mayChangeData(request) &&
    !state.confirm('environment.confirmSend', {
      v0: environment.name,
      v1: request.protocol === 'graphql' ? 'GraphQL' : request.method.toUpperCase(),
      v2: request.url,
    })
  )
    return undefined;
  const response = await state.cases.send(
    request,
    {
      workspace: state.workspaceId(),
      environmentId: environment?.id ?? '',
      environment: toVariableRows((environment?.value as { values?: unknown })?.values),
      globals: state.globalRows(),
      ancestors: state.activeAncestors(),
    },
    state.cases.files.id(),
  );
  const history = await state.cases.createDocument(
    state.workspaceId(),
    'history',
    `${request.method} ${request.url}`,
    { request: historyRequest(request), response: historyResponse(response) },
  );
  state.applySaved([history]);
  return response;
}
