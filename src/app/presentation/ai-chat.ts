import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { AiAnswer as Answering, AiWritten } from '../application/ai-use-cases';
import { AI } from '../composition/providers';
import {
  AI_ACTIONS,
  AI_PROVIDERS,
  AiMessage,
  AiPlace,
  AiUse,
  aiMissing,
  stopNote,
} from '../domain/ai';
import { AiAnswer } from './ai-answer';
import { AiChatSession, ShownConversation, freshConversation as fresh } from './ai-chat/session';
import { AiHost, requestHost, sqlHost } from './ai-hosts';
import { AiSettingsPanel } from './ai-settings';
import { DbSection } from './db-panel/section';
import { Splitter } from './splitter';
import { WorkspaceState, success } from './workspace-state';

/** The narrowest the chat gets, and the room it always leaves to what it sits beside. */
const WIDTH = { min: 280, room: 320 };

/**
 * The AI assistant beside the SQL editor, a MongoDB collection or a request (IA-01): the
 * person asks, or picks one of the questions of the place; the model reads what is open with
 * its tools, the answer streams in and can be stopped, and its code goes where the place
 * takes it. Each conversation is kept in the workspace. Until the assistant is set up, the
 * panel shows its settings.
 */
@Component({
  imports: [TranslocoPipe, FormField, AiSettingsPanel, AiAnswer, Splitter],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-ai-chat',
  host: { '[class.ai-floating]': 'floating()' },
  templateUrl: './ai-chat.html',
  styleUrls: ['./db-sql-side.scss', './ai-chat.scss'],
})
export class AiChat {
  private readonly ai = inject(AI);
  private readonly transloco = inject(TranslocoService);
  private readonly section = inject(DbSection, { optional: true });
  protected readonly state = inject(WorkspaceState);
  private readonly session = inject(AiChatSession);
  protected readonly width = this.session.width;
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  readonly place = input.required<AiPlace>();
  /** Over the screen, at its right, where there is no room beside it. */
  readonly floating = input(false);
  /** What the tools read and where code goes, when the place gives its own. */
  readonly host = input<AiHost | undefined>(undefined);
  private readonly where = computed<AiHost | undefined>(() => {
    const given = this.host();
    if (given) return given;
    if (this.place() === 'request') return requestHost(this.state);
    const translate = (key: string, params?: Record<string, string>) =>
      this.transloco.translate(key, params);
    return this.place() === 'sql' && this.section ? sqlHost(this.section, translate) : undefined;
  });
  /** The questions offered in this place. */
  protected readonly actions = computed(() => AI_ACTIONS[this.place()]);
  /** The connection the tools read: the one the person works with here. */
  protected readonly reads = computed(() => this.where()?.context()?.connection);
  readonly closed = output<void>();
  protected readonly settings = signal(this.ai.settings());
  /** Whether the vault keeps the provider's key; unknown until it is asked. */
  protected readonly hasKey = signal<boolean | undefined>(undefined);
  protected readonly missing = computed(() => {
    const kept = this.hasKey();
    return kept === undefined ? undefined : aiMissing(this.settings(), kept);
  });
  protected readonly list = signal<{ id: string; title: string }[]>([]);
  protected readonly current = signal<ShownConversation>(fresh());
  protected readonly question = signal({ text: '' });
  protected readonly fields = form(this.question);
  /** The answer being written and its reasoning, as far as they came; `undefined` when none is. */
  protected readonly writing = signal<AiWritten | undefined>(undefined);
  protected readonly error = signal('');
  /** Its settings are shown in its place, to choose another provider or model. */
  protected readonly changing = signal(false);
  protected readonly provider = computed(
    () => AI_PROVIDERS.find((provider) => provider.id === this.settings().provider)?.name ?? '',
  );
  protected readonly note = stopNote;
  private answer?: Answering;
  /** Whether what the place showed last is on screen again, so it may be kept. */
  private restored = false;

  constructor() {
    void this.refresh();
    // The conversation and question the place showed last in this workspace, or a new one.
    effect(() => {
      const workspace = this.state.workspaceId();
      untracked(() => {
        const shown = this.session.shown()[this.place()];
        const same = shown?.workspace === workspace;
        this.current.set(same ? shown.conversation : fresh());
        this.question.set({ text: same ? shown.question : '' });
        this.restored = true;
        void this.loadList(workspace);
      });
    });
    effect(() => {
      const shown = {
        workspace: this.state.workspaceId(),
        conversation: this.current(),
        question: this.question().text,
      };
      if (this.restored)
        untracked(() => this.session.shown.update((all) => ({ ...all, [this.place()]: shown })));
    });
  }

  /** A width dragged to, kept between the narrowest and the room of what it sits beside. */
  protected resize(width: number) {
    const room = (this.element.parentElement?.clientWidth || innerWidth) - WIDTH.room;
    this.width.set(Math.max(WIDTH.min, Math.min(width, room)));
  }

  /** Back from its settings, with what was chosen there. */
  protected changed() {
    this.changing.set(false);
    void this.refresh();
  }

  /** The settings and the key, read again after they change. */
  protected async refresh() {
    const settings = this.ai.settings();
    this.settings.set(settings);
    this.hasKey.set(await this.ai.hasKey(settings.provider).catch(() => false));
  }

  private async loadList(workspace = this.state.workspaceId()) {
    this.list.set(await this.ai.conversations(workspace).catch(() => []));
  }

  protected async open(id: string) {
    if (!id || this.writing() !== undefined) return;
    try {
      const conversation = await this.ai.conversation(id);
      this.current.set({
        id: conversation.id,
        revision: conversation.revision,
        messages: conversation.messages,
      });
      this.error.set('');
    } catch (error) {
      this.error.set(this.state.describe(error));
    }
  }

  protected start() {
    if (this.writing() !== undefined) return;
    this.current.set(fresh());
    this.error.set('');
  }

  protected async send() {
    const text = this.question().text.trim();
    if (!text || this.writing() !== undefined || this.missing()) return;
    const messages: AiMessage[] = [...this.current().messages, { role: 'user', text }];
    this.current.update((current) => ({ ...current, messages }));
    this.question.set({ text: '' });
    this.writing.set({ text: '', thinking: '', steps: [] });
    this.error.set('');
    let message: AiMessage;
    try {
      this.answer = await this.ai.ask(
        this.settings(),
        this.state.workspaceId(),
        this.place(),
        messages,
        (written) => this.writing.set(written),
        () => this.where()?.context(),
      );
      message = await this.answer.done;
    } catch (error) {
      message = { role: 'assistant', text: '', failed: this.state.describe(error) };
    }
    this.answer = undefined;
    this.writing.set(undefined);
    await this.keep(message);
  }

  /** Adds the answer to the conversation and saves it in the workspace. */
  private async keep(message: AiMessage) {
    const current = { ...this.current(), messages: [...this.current().messages, message] };
    this.current.set(current);
    try {
      const saved = await this.ai.save(
        this.state.workspaceId(),
        { id: current.id, place: this.place(), messages: current.messages },
        current.revision,
      );
      this.current.update((now) =>
        now.id === current.id ? { ...now, revision: saved.revision } : now,
      );
      if (current.revision === undefined) await this.loadList();
    } catch (error) {
      this.error.set(this.state.describe(error));
    }
  }

  protected stop() {
    this.answer?.stop();
  }

  /** One of the questions of the place, asked in the person's language. */
  protected quick(action: string) {
    this.question.set({ text: this.transloco.translate(`ai.ask.${action}`) });
    void this.send();
  }

  /** A block of code of an answer goes where the place takes it. */
  protected use(use: AiUse) {
    this.where()?.use(use);
  }

  protected keydown(event: KeyboardEvent) {
    // Enter sends; Shift+Enter starts a new line.
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void this.send();
  }

  protected copy(text: string) {
    void globalThis.navigator?.clipboard?.writeText(text);
    this.state.tell(success('Copied to the clipboard'));
  }

  protected async remove() {
    const { id, revision } = this.current();
    if (revision === undefined || this.writing() !== undefined) return;
    if (!this.state.confirm('Delete this conversation?')) return;
    try {
      await this.ai.remove(this.state.workspaceId(), id, revision);
      this.current.set(fresh());
      await this.loadList();
    } catch (error) {
      this.error.set(this.state.describe(error));
    }
  }
}
