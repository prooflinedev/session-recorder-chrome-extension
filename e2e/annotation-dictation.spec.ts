import { test, expect, dispatch, tabIdForUrl, extUrl } from './support';
import type { WebSocketRoute } from '@playwright/test';

for (const provider of ['deepgram', 'elevenlabs'] as const) test(`${provider}: dictates using the recording mic and page vocabulary`, async ({ context, background, extensionId }) => {
  let socket: WebSocketRoute | undefined;
  let dictionary: string[] = [];
  await context.route('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', route => route.fulfill({ json: {token:'test-single-use'} }));
  await context.routeWebSocket(provider === 'deepgram' ? 'wss://api.deepgram.com/**' : 'wss://api.elevenlabs.io/**', ws => {
    socket = ws;
    dictionary = new URL(ws.url()).searchParams.getAll(provider === 'deepgram' ? 'keyterm' : 'keyterms');
    ws.onMessage(message => {
      if (typeof message !== 'string') return;
      try { const json = JSON.parse(message); if (json.type === 'Configure') dictionary = json.keyterms; } catch {}
    });
  });
  const media = await context.newPage();
  await media.goto(extUrl(extensionId, 'offscreen.html'));
  await background.evaluate(async (provider) => {
    // Run the real offscreen module in an inspectable extension page so Playwright
    // can intercept provider sockets; Chrome hides actual offscreen targets.
    chrome.offscreen.createDocument = async () => {};
    chrome.offscreen.closeDocument = async () => {};
    await chrome.storage.local.set({
      micGranted: true,
      transcription: { provider, apiKey:'test-only', model:provider === 'deepgram' ? 'nova-3' : 'scribe_v2' },
      sharingSettings: { provider:'compatible', models:{compatible:{apiKey:'',model:'test',baseUrl:'http://localhost:5319/v1'}} },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('localhost:5319/v1/chat/completions')) return new Response(JSON.stringify({choices:[{message:{content:'{"terms":["Proofline","Finishing recipes"]}'}}]}), {headers:{'Content-Type':'application/json'}});
      return realFetch(input,init);
    };
  }, provider);
  const page = await context.newPage();
  await page.goto('/');
  await page.locator('h1').evaluate(el => { el.textContent = 'Proofline Finishing recipes'; });
  const tabId = await tabIdForUrl(background, 'http://localhost:5319');
  const started = await dispatch<{session:{id:string;startedAt:number}}>(background,{kind:'session/start',tabId});
  await dispatch(background,{kind:'point-annotation/toggle',on:true});
  const host = page.locator('#__session_recorder_point_annotation_host__');
  const bounds = await page.locator('#btn-get').boundingBox();
  await page.mouse.click(bounds!.x+4,bounds!.y+4);
  const input = host.getByRole('textbox',{name:'Comment',exact:true});
  await expect(input).toBeVisible();
  await host.getByRole('button',{name:'Dictate comment',exact:true}).click();
  await expect(host.getByRole('button',{name:'Turn off dictation microphone'})).toHaveAttribute('aria-pressed','true');
  await expect.poll(()=>!!socket).toBe(true);
  await expect.poll(()=>dictionary).toContain('Proofline');
  const result = (text:string,final:boolean,start:number) => socket!.send(JSON.stringify(provider === 'elevenlabs' ? {message_type:final?'committed_transcript':'partial_transcript',text} : {type:'Results',start,duration:1,is_final:final,channel:{alternatives:[{transcript:text,words:[]}]}}));
  // Receive-to-render latency for an injected provider event; it excludes the
  // provider's own recognition time, which only a live measurement can show.
  await page.evaluate(() => {
    const field = document.querySelector('#__session_recorder_point_annotation_host__')!.shadowRoot!.querySelector('textarea')!;
    const watch = () => (field.value ? ((window as any).__renderedAt = Date.now()) : setTimeout(watch, 1));
    watch();
  });
  const sentAt = Date.now();
  result('Finishing recipe',false,1);
  await expect(input).toHaveValue('Finishing recipe');
  console.log(`${provider} dictation: provider event to rendered comment ${(await page.evaluate(() => (window as any).__renderedAt)) - sentAt} ms`);
  result('Finishing recipes needs help.',true,1);
  await expect(input).toHaveValue('Finishing recipes needs help.');
  if (provider === 'deepgram') result('Finishing recipes needs help.',true,1);
  await expect(input).toHaveValue('Finishing recipes needs help.');
  await input.press('Enter');
  await expect(host.getByRole('status')).toHaveText('Comment added to the recording.');
  await page.mouse.click(bounds!.x+4,bounds!.y+4);
  await expect(input).toHaveValue('');
  // A late result for the previous utterance must not leak into the new comment.
  const prior = {kind:'transcript/final',sessionId:started.session.id,tStart:0,tEnd:100,text:'old comment',provider:'deepgram'};
  await dispatch(background,prior);
  await expect(input).toHaveValue('');
  // The mic stays on; no second mic click is needed for the next comment.
  result('Add a useful empty state.',true,60);
  await expect(input).toHaveValue('Add a useful empty state.');
  await input.fill('A manually corrected comment.');
  await page.screenshot({path:`.impeccable/review/annotation-dictation-${provider}.png`});
  // A live socket failure reaches the open comment and keeps its text.
  await dispatch(background,{kind:'transcript/error',sessionId:started.session.id,error:'Live transcription disconnected.'});
  await expect(host.getByRole('status')).toHaveText('Transcription failed: Live transcription disconnected. Type the rest of your comment.');
  await expect(input).toHaveValue('A manually corrected comment.');
  await page.screenshot({path:`.impeccable/review/annotation-dictation-${provider}-error.png`});
  await dispatch(background,{kind:'session/stop'});
  // Dictated utterances belong to their comments; the earlier stray result stays narration.
  const {events} = await dispatch<{events:Array<{type:string;payload:any}>}>(background,{kind:'events/get',sessionId:started.session.id});
  const voice = events.filter(e => e.type === 'voice-segment' && e.payload.transcript);
  expect(voice.map(e => [e.payload.transcript, e.payload.dictation === true])).toEqual(expect.arrayContaining([
    ['Finishing recipes needs help.', true],
    ['Add a useful empty state.', true],
    ['old comment', false],
  ]));
});
