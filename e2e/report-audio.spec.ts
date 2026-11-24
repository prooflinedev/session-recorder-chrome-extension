import { test, expect, dispatch, extUrl, tabIdForUrl } from './support';

function wavDataUrl(): string {
  const sampleRate = 8_000;
  const sampleCount = sampleRate;
  const dataSize = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = Math.round(
      Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 3_000,
    );
    wav.writeInt16LE(sample, 44 + i * 2);
  }
  return `data:audio/wav;base64,${wav.toString('base64')}`;
}

test('plays stored narration audio from the full report timeline', async ({
  context,
  background,
  extensionId,
}) => {
  const demo = await context.newPage();
  await demo.goto('/');
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<{
    ok: boolean;
    session: { id: string };
  }>(background, { kind: 'session/start', tabId });
  expect(started.ok).toBe(true);

  const dataUrl = wavDataUrl();
  for (let i = 0; i < 2; i += 1) {
    await dispatch(background, {
      kind: 'audio/segment',
      sessionId: started.session.id,
      tStart: i * 1_000,
      tEnd: (i + 1) * 1_000,
      dataUrl,
      mime: 'audio/wav',
    });
    await demo.waitForTimeout(30);
  }
  await dispatch(background, { kind: 'session/stop' });

  const report = await context.newPage();
  await report.goto(
    extUrl(extensionId, `report.html?session=${started.session.id}&level=L0`),
  );
  await expect(report.locator('.r-voice audio')).toHaveCount(2);

  // Add transcript-only and dictated voice events to cover both report cases.
  await report.evaluate(async (sessionId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('session-recorder');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction('events', 'readwrite');
    const store = tx.objectStore('events');
    const existing = await new Promise<any[]>((resolve, reject) => {
      const request = store.index('by-session').getAll(
        IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]),
      );
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const audioEvent = existing.find(
      (event) => event.type === 'voice-segment' && event.payload.assetId,
    );
    if (!audioEvent) throw new Error('Test recording did not store audio.');
    audioEvent.payload.transcript = 'A spoken explanation for this recording.';
    await store.put(audioEvent);
    const nextTime = Math.max(...existing.map((event) => event.t)) + 1_000;
    await store.put({
      id: 'test-transcript-only',
      sessionId,
      t: nextTime,
      type: 'voice-segment',
      importance: 90, protected: true,
      payload: {
        tStart: nextTime,
        tEnd: nextTime + 500,
        transcript: 'Transcript without an audio file.',
      },
    });
    await store.put({
      id: 'test-context-separator', sessionId, t: nextTime + 600,
      type: 'note', importance: 90, protected: true, payload: { text: 'Context separator' },
    });
    await store.put({
      id: 'test-context-voice', sessionId, t: nextTime + 700,
      type: 'voice-segment', importance: 90, protected: true,
      payload: { tStart: nextTime + 700, tEnd: nextTime + 900, transcript: 'Contextual narration.', anchorContext: 'reviewing the checkout form' },
    });
    await store.put({
      id: 'test-comment-dictation',
      sessionId,
      t: nextTime + 1_000,
      type: 'voice-segment',
      importance: 90, protected: true,
      payload: {
        tStart: nextTime + 1_000,
        tEnd: nextTime + 1_500,
        transcript: 'Comment dictation stays hidden.',
        dictation: true,
      },
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, started.session.id);
  await report.reload();

  await expect(report.getByText(/A spoken explanation for this recording/)).toBeVisible();
  await expect(report.getByText(/Transcript without an audio file/)).toBeVisible();
  await expect(report.getByText('Comment dictation stays hidden.')).toHaveCount(0);
  await expect(report.getByText('while reviewing the checkout form', { exact: true })).toBeVisible();
  const players = report.locator('.r-voice audio');
  await expect(players).toHaveCount(2);
  await expect(players.first()).toHaveAttribute('preload', 'metadata');

  await players.first().evaluate(async (audio: HTMLAudioElement) => {
    await audio.play();
  });
  await expect
    .poll(() =>
      players.first().evaluate((audio: HTMLAudioElement) => audio.currentTime),
    )
    .toBeGreaterThan(0.05);

  await report.getByRole('button', { name: 'Minimal', exact: true }).click();
  await expect(report.locator('.r-voice audio')).toHaveCount(2);
});
