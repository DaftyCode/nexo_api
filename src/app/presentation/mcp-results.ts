import { TranslocoPipe } from '@jsverse/transloco';
import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { McpPrompt, McpView } from '../domain/integration-views';

/** A JSON-RPC call the person asked for from a result: sent now, or written in the form. */
export interface McpCall {
  method: string;
  params: Record<string, unknown>;
  send: boolean;
}

/**
 * What an MCP server answered: its tools, resources and prompts, with actions to read a
 * resource or get a prompt with its arguments, and what those returned.
 */
@Component({
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-mcp-results',
  styleUrl: './mcp-results.scss',
  templateUrl: './mcp-results.html',
})
export class McpResults {
  readonly view = input.required<McpView>();
  readonly call = output<McpCall>();
  /** Arguments typed for each prompt, by prompt and argument name. */
  protected readonly arguments = signal<Record<string, Record<string, string>>>({});

  protected typed(prompt: string, name: string) {
    return this.arguments()[prompt]?.[name] ?? '';
  }
  protected setArgument(prompt: string, name: string, event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.arguments.update((all) => ({ ...all, [prompt]: { ...all[prompt], [name]: value } }));
  }
  /** A prompt can be asked for once its required arguments have a value. */
  protected ready(prompt: McpPrompt) {
    return prompt.arguments.every(
      (argument) => !argument.required || this.typed(prompt.name, argument.name).trim(),
    );
  }
  protected getPrompt(prompt: McpPrompt) {
    const given = Object.fromEntries(
      prompt.arguments
        .map((argument) => [argument.name, this.typed(prompt.name, argument.name).trim()])
        .filter(([, value]) => value),
    );
    this.call.emit({
      method: 'prompts/get',
      params: { name: prompt.name, arguments: given },
      send: true,
    });
  }
  protected read(uri: string) {
    this.call.emit({ method: 'resources/read', params: { uri }, send: true });
  }
  /** A template's URI goes to the form, to fill in its variables. */
  protected useTemplate(uri: string) {
    this.call.emit({ method: 'resources/read', params: { uri }, send: false });
  }
  protected useTool(name: string) {
    this.call.emit({ method: 'tools/call', params: { name, arguments: {} }, send: false });
  }
}
