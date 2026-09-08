import { describe, it, expect } from 'vitest';
import { SseParser } from '../../src/kimi/sse.js';

describe('SseParser', () => {
  it('dispatches on the blank line and joins multi-line data', () => {
    const parser = new SseParser();
    expect(parser.feed('event: a\ndata: 1\ndata: 2\n\n')).toEqual([{ event: 'a', data: '1\n2' }]);
  });

  it('is indifferent to how the bytes are chunked', () => {
    const text = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: ping\ndata: {"type":"ping"}\n\n';
    const whole = new SseParser().feed(text);
    const parser = new SseParser();
    const piecewise = [...text].flatMap((ch) => parser.feed(ch));
    expect(piecewise).toEqual(whole);
    expect(whole).toHaveLength(2);
  });

  it('accepts CRLF and lone CR line endings, including a CR split across chunks', () => {
    const parser = new SseParser();
    // `\r` + `\n` across the chunk boundary is one line ending, not two; a
    // lone `\r` ends a line; the trailing `\r` is held until the next byte.
    const events = [...parser.feed('data: a\r'), ...parser.feed('\ndata: b\r\rdata: c\n\n')];
    expect(events).toEqual([{ event: '', data: 'a\nb' }, { event: '', data: 'c' }]);
    expect(parser.feed('data: d\r')).toEqual([]);
    expect(parser.flush()).toEqual([{ event: '', data: 'd' }]);
  });

  it('ignores comments and unknown fields, and keeps data without a leading space', () => {
    const parser = new SseParser();
    expect(parser.feed(': keep-alive\nid: 7\nretry: 100\ndata:x\n\n')).toEqual([{ event: '', data: 'x' }]);
  });

  it('flushes a trailing event that has no closing blank line', () => {
    const parser = new SseParser();
    expect(parser.feed('data: [DONE]')).toEqual([]);
    expect(parser.flush()).toEqual([{ event: '', data: '[DONE]' }]);
    expect(parser.flush()).toEqual([]);
  });

  it('resets the event name after a dispatch and after an empty block', () => {
    const parser = new SseParser();
    expect(parser.feed('event: a\n\ndata: 1\n\n')).toEqual([{ event: '', data: '1' }]);
  });
});
