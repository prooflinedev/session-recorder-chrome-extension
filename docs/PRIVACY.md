# Privacy Policy — Session Recorder by Proofline

_Last updated: 2026-10-30_

Session Recorder is a Chrome extension that records a session of you using a web
app — interactions, network traffic, console logs, screenshots, voice narration,
annotations, and files — and exports it as a local zip report intended for an LLM
coding agent.

> Connecting Proofline automatically uses its workspace credits for AI, private report hosting and GitHub App issue filing. Personal-provider and Cloudflare integrations remain available when disconnected.

## Summary

- **Recordings stay on your machine by default.** Sessions are stored locally in
  your browser (IndexedDB) and exported as a zip file you save yourself. Connecting Proofline is optional. Recording and local export do not require an account.
- **Voice transcription is optional.** If — and only if — you
  configure personal transcription credentials or connect Proofline, recorded audio is sent to the selected service to produce a text transcript.
- **Publishing and AI summaries are optional.** Publishing sends the selected
  report and its included assets to your selected Proofline workspace or Cloudflare account. Generating a summary
  sends a bounded text excerpt to your configured model provider or, in managed mode, through Proofline to its configured provider. Filing a
  GitHub issue sends its title, summary and report link to GitHub.

## What the extension accesses

To record a session, the extension captures, on the tabs you are actively
recording:

- Network requests and responses (via `chrome.debugger` / CDP), including bodies
  and headers
- Console logs, exceptions, and failed requests
- Clicks, inputs, scrolls, keystrokes, and page navigations
- Screenshots of the recorded tab
- Microphone audio, when you start voice narration
- Files you upload to the app or attach yourself

All of this is written to local browser storage. You can export a local ZIP or
explicitly publish the selected report to Proofline or your Cloudflare Pages project.

## Redaction

Redaction is on by default. For supported structured capture fields, the extension
masks authorization headers, token-like JSON/form fields, sensitive URL
parameters, and password inputs. URL rules cover query strings and fragments
(for example `#access_token=…`) in network requests and in the page, navigation
and tab URLs stored with a recording. You can add rules or disable redaction per
session on the options page. Screenshots, audio, attached files and arbitrary text may still contain sensitive information.

## Third-party transcription (optional, off by default)

If you enter an API key on the options page, recorded audio is streamed or
uploaded to the provider you selected in order to transcribe it:

- **Deepgram** — https://deepgram.com/privacy
- **OpenAI** — https://openai.com/policies/privacy-policy
- **ElevenLabs** — https://elevenlabs.io/privacy

Your API key is stored locally in `chrome.storage.local` and is sent only to that
provider. In personal-key mode, Proofline does not receive or proxy your key or audio. Your use of
a provider is governed by that provider's privacy policy and terms.

## Optional annotation dictation

Annotation comments use the recording microphone and your configured transcription
provider. With the mic on, speech fills the active comment; its mic button can
start or stop the recording microphone. Audio remains part of the session's voice
recording. Deepgram and ElevenLabs provide live results; OpenAI uses audio segments.
Typing does not start the microphone.

When an annotation is selected and an AI model is configured, a bounded excerpt
of visible headings, navigation and interface labels is sent to that model to
identify unusual vocabulary. Input values, editable fields and hidden content are
excluded. The resulting short dictionary is sent to Deepgram or ElevenLabs to
improve recognition. Page context stays in memory. Managed transcription saves its dictionary and request identity locally with the audio segment so a retry preserves the original operation. These fields are excluded from published and exported reports. Personal-key dictionaries remain in memory. Provider fees apply;
ElevenLabs charges extra for keyterm prompting. If extraction fails, ordinary
transcription remains available.

## Optional report publishing and summaries

Cloudflare publishing uploads the report, session data, transcripts and included
screenshots, recordings and files directly to your Cloudflare account. Cloudflare
Access controls who can sign in. You configure the reader policy. A deployed
Function also validates Access tokens before serving report files. Reports remain
hosted until you delete their deployments; deleting a local session does not
unpublish it. Use Unpublish report or your Cloudflare dashboard to delete it.

Personal-provider AI summaries send up to 60,000 characters of text evidence to OpenAI, Anthropic,
Google or the OpenAI-compatible endpoint you select, when you choose
File GitHub issue with a configured model or Regenerate summary. With a configured model, stopping a recording also sends this bounded text evidence to generate its session-list title automatically. No media bytes are sent for summarization or naming. The text may still
contain sensitive data; review it before sending. Provider terms and retention
policies apply. Review generated summaries before sharing them.

GitHub receives the title, summary and protected page link when you choose File GitHub issue. The extension creates the issue with your configured GitHub token or the installed Proofline GitHub App. The summary follows the repository’s visibility; the report’s access policy protects the hosted report, not the issue text. Drafts, deployment references, created issues and recovery markers are saved locally. Copy issue Markdown writes the text to your clipboard only when you choose it.

API credentials stay in extension storage and are sent only to their configured
service. They are not included in report bundles or deployed pages. Screenshots,
voice and arbitrary attachments are not automatically scrubbed of all sensitive
information. Review them before publishing.

## Optional Proofline services

Connecting Proofline uses browser approval to store an expiring, workspace-scoped token in trusted extension storage. Connecting automatically enables paid AI using that workspace’s credits, including summaries, session titles, page vocabulary and transcription when you record audio. Connected service settings cannot select personal keys or override models. Disconnect to use standalone integrations. Personal provider keys remain local and are never sent to Proofline.

In Proofline AI mode, bounded text for summaries, session titles and page vocabulary is sent through the Proofline server to configured model providers. Recorded speech is decoded to mono audio and sent through Proofline to Deepgram or ElevenLabs. Provider credentials stay on the server. Paid usage is attributed to the workspace you select and recorded in Proofline’s credit ledger. AI pauses when credits are unavailable; the extension never silently switches to your personal keys or another workspace.

Publishing to Proofline sends the selected report Markdown and included attachments. Reports are private to their creator and explicitly permitted readers. Outside readers need a free Proofline account and an invitation. Reports remain until deleted, subject to the workspace storage limit; deleting a local session does not delete a hosted report. Use the report’s delete action to remove the hosted copy.

## Data sharing and sale

The extension has no advertising or analytics. Optional Proofline services process the evidence and usage information described above. AI providers receive the inputs needed for your selected operations; GitHub receives issue contents when you file an issue. The extension does not sell recorded data.

## Contact

Questions: open an issue at https://github.com/prooflinedev/session-recorder-chrome-extension/issues
