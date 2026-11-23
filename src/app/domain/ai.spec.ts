import {
  DEFAULT_AI_SETTINGS,
  aiInstructions,
  aiKeyName,
  aiMissing,
  conversationTitle,
  readAiSettings,
  readConversation,
  stopNote,
  withProvider,
} from './ai';

describe('the AI assistant', () => {
  it('reads its settings, the defaults for anything unreadable', () => {
    expect(readAiSettings(undefined)).toEqual(DEFAULT_AI_SETTINGS);
    expect(readAiSettings('not json')).toEqual(DEFAULT_AI_SETTINGS);
    expect(readAiSettings('[1]').provider).toBe('anthropic');
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
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      effort: 'high',
    });
  });

  it('starts another provider with its first model and keeps the effort only for Anthropic', () => {
    const anthropic = { ...DEFAULT_AI_SETTINGS, effort: 'high' as const, proxy: 'p' };
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
    const on = { ...DEFAULT_AI_SETTINGS, enabled: true };
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
      ],
    });
    expect(readConversation({ id: 'c2', name: 'x' })).toEqual({
      id: 'c2',
      title: 'x',
      place: 'request',
      messages: [],
    });
  });
});
