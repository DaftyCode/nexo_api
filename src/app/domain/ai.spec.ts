import {
  DEFAULT_AI_SETTINGS,
  aiInstructions,
  aiKeyName,
  aiMissing,
  byteSize,
  conversationTitle,
  localReady,
  readAiSettings,
  readConversation,
  stopNote,
  thoughtSeconds,
  withProvider,
} from './ai';

describe('the AI assistant', () => {
  it('reads its settings, the defaults for anything unreadable', () => {
    expect(readAiSettings(undefined)).toEqual(DEFAULT_AI_SETTINGS);
    expect(readAiSettings('not json')).toEqual(DEFAULT_AI_SETTINGS);
    expect(readAiSettings('[1]').provider).toBe('local');
    expect(
      readAiSettings(
        JSON.stringify({
          enabled: true,
          provider: 'compatible',
          model: ' local ',
          baseUrl: 'http://127.0.0.1:8080/v1',
          effort: 'extreme',
          proxy: 'p1',
        }),
      ),
    ).toEqual({
      enabled: true,
      provider: 'compatible',
      model: 'local',
      baseUrl: 'http://127.0.0.1:8080/v1',
      effort: '',
      proxy: 'p1',
    });
    expect(readAiSettings(JSON.stringify({ provider: 'other', effort: 'high' }))).toMatchObject({
      provider: 'local',
      model: 'local',
      effort: 'high',
    });
    expect(readAiSettings(JSON.stringify({ provider: 'anthropic' })).model).toBe('claude-opus-5-5');
  });

  it('starts another provider with its first model and keeps the effort only for Anthropic', () => {
    const anthropic = {
      ...DEFAULT_AI_SETTINGS,
      provider: 'anthropic' as const,
      effort: 'high' as const,
      proxy: 'p',
    };
    expect(withProvider(anthropic, 'openai')).toMatchObject({
      provider: 'openai',
      model: '',
      effort: '',
      proxy: 'p',
    });
    expect(withProvider(anthropic, 'anthropic').effort).toBe('high');
    expect(aiKeyName('gemini')).toBe('ai:gemini');
  });

  it('says what is missing before it can answer', () => {
    const local = { ...DEFAULT_AI_SETTINGS, enabled: true };
    expect(aiMissing(local, false)).toBe('ai.missing.local');
    expect(aiMissing(local, true)).toBeUndefined();
    const on = { ...local, provider: 'anthropic' as const, model: 'claude-opus-5-5' };
    expect(aiMissing(DEFAULT_AI_SETTINGS, true)).toBe('ai.missing.off');
    expect(aiMissing(on, false)).toBe('ai.missing.key');
    expect(aiMissing(on, true)).toBeUndefined();
    expect(aiMissing({ ...on, model: '' }, true)).toBe('ai.missing.model');
    const compatible = { ...on, provider: 'compatible' as const, model: 'local' };
    expect(aiMissing(compatible, false)).toBe('ai.missing.address');
    expect(aiMissing({ ...compatible, baseUrl: 'http://h/v1' }, false)).toBeUndefined();
  });

  it('names a conversation by its first question and explains an early end', () => {
    expect(conversationTitle('  Why is this slow?\nSELECT 1')).toBe('Why is this slow?');
    expect(conversationTitle('x'.repeat(80))).toHaveLength(60);
    expect(conversationTitle('')).toBe('');
    expect(stopNote('refusal')).toBe('ai.stop.refusal');
    expect(stopNote('safety')).toBe('ai.stop.refusal');
    expect(stopNote('max_tokens')).toBe('ai.stop.length');
    expect(stopNote('length')).toBe('ai.stop.length');
    expect(stopNote('stopped')).toBe('ai.stop.stopped');
    expect(stopNote('end_turn')).toBeUndefined();
    expect(stopNote(undefined)).toBeUndefined();
    expect(thoughtSeconds(1000, 5400)).toBe(4);
    expect(thoughtSeconds(1000, 1000)).toBe(1);
  });

  it('tells the model where the person is', () => {
    expect(aiInstructions('sql')).toContain('SQL');
    expect(aiInstructions('mongo')).toContain('MongoDB');
    expect(aiInstructions('request')).toContain('HTTP requests');
    expect(aiInstructions('sql')).toContain('language the person writes in');
  });

  it('reads a kept conversation, leaving out what is not a message', () => {
    expect(
      readConversation({
        id: 'c1',
        name: 'Why?',
        value: {
          place: 'sql',
          messages: [
            { role: 'user', text: 'Why?' },
            { role: 'assistant', text: 'Because', stop: 'stopped' },
            { role: 'assistant', text: 'So', thinking: 'Why', thought: 4, failed: 'Late' },
            { role: 'assistant', text: 'Odd', thinking: 5, thought: 'long', stop: 1 },
            { role: 'system', text: 'x' },
            { role: 'user' },
            null,
          ],
        },
      }),
    ).toEqual({
      id: 'c1',
      title: 'Why?',
      place: 'sql',
      messages: [
        { role: 'user', text: 'Why?' },
        { role: 'assistant', text: 'Because', stop: 'stopped' },
        { role: 'assistant', text: 'So', thinking: 'Why', thought: 4, failed: 'Late' },
        { role: 'assistant', text: 'Odd' },
      ],
    });
    expect(readConversation({ id: 'c2', name: 'x' })).toEqual({
      id: 'c2',
      title: 'x',
      place: 'request',
      messages: [],
    });
  });

  it('says when the local model can answer and writes sizes as people read them', () => {
    expect(localReady(undefined)).toBe(false);
    const status = { engine: true, model: 'qwen3.5-4b' } as Parameters<typeof localReady>[0];
    expect(localReady(status)).toBe(true);
    expect(localReady({ ...status!, model: null })).toBe(false);
    expect(byteSize(5_680_522_464)).toBe('5.7 GB');
    expect(byteSize(38_935_891)).toBe('39 MB');
    expect(byteSize(10)).toBe('1 MB');
  });
});
