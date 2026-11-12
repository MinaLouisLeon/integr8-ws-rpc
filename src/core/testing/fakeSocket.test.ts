import { describe, expect, it } from 'vitest';
import { FakeSocket } from './fakeSocket.js';

describe('FakeSocket', () => {
  it('does not open or send until the test explicitly opens it', () => {
    const fake = new FakeSocket();
    expect(fake.socket.readyState).toBe(0);
    expect(() => fake.socket.send('hello')).toThrow();
    fake.open();
    fake.socket.send('é');
    expect(fake.sent).toEqual(['é']);
    expect(fake.socket.bufferedAmount).toBe(2);
    fake.drain();
    expect(fake.socket.bufferedAmount).toBe(0);
  });

  it('delivers controlled messages and removes listeners by identity', () => {
    const fake = new FakeSocket();
    const received: unknown[] = [];
    const listener = (event: MessageEvent): void => {
      received.push(event.data);
    };
    fake.socket.addEventListener('message', listener);
    fake.socket.addEventListener('message', listener);
    expect(fake.listenerCount).toBe(1);
    fake.receive('before');
    fake.socket.removeEventListener('message', listener);
    fake.receive('after');
    expect(received).toEqual(['before']);
    expect(fake.listenerCount).toBe(0);
  });

  it('accounts for once and aborted listeners without retaining registrations', () => {
    const fake = new FakeSocket();
    const controller = new AbortController();
    let opens = 0;
    fake.socket.addEventListener(
      'open',
      () => {
        opens += 1;
      },
      { once: true },
    );
    fake.socket.addEventListener('message', () => {}, { signal: controller.signal });
    expect(fake.listenerCount).toBe(2);
    fake.open();
    expect(opens).toBe(1);
    expect(fake.listenerCount).toBe(1);
    controller.abort();
    expect(fake.listenerCount).toBe(0);
  });

  it('supports close races and deliberate late events from an old socket', () => {
    const fake = new FakeSocket();
    const received: unknown[] = [];
    fake.socket.addEventListener('message', (event) => {
      received.push(event.data);
    });
    fake.open();
    fake.socket.close(1000, 'closed');
    expect(fake.socket.readyState).toBe(2);
    expect(() => fake.socket.send('late send')).toThrow();
    fake.finishClose();
    expect(fake.socket.readyState).toBe(3);
    fake.receive('late queued message');
    expect(received).toEqual(['late queued message']);
  });
});
