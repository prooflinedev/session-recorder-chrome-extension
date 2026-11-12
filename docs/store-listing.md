# Chrome Web Store listing

Publication copy for **Session Recorder by Proofline**. Match the submitted package and deployed services; this file does not establish that a store update or publisher transfer has happened.

## Listing identity

- Item ID: `dboiheheijgmfpfhbmjggiijpgondghh`.
- Name: Session Recorder by Proofline.
- Category: Developer Tools.
- Language: English.
- Source and issue support: https://github.com/prooflinedev/session-recorder-chrome-extension.
- Website destination: https://proofline.sh/session-recorder-chrome-extension/.
- Privacy policy destination: https://proofline.sh/session-recorder-chrome-extension/privacy/.

Keep the existing item ID. Set the listing website to the recorder overview and the support URL to https://proofline.sh/help/session-recorder/. Confirm the publisher and privacy disclosures against the submitted package.

## Short description

Record steps to reproduce a bug with screenshots, console logs and network requests. Export to Markdown or file a GitHub issue.

## Detailed description

Record a website bug in Chrome and give the developer who picks it up the steps to reproduce it. Session Recorder keeps clicks, page navigation, screenshots, console errors and network requests on one timeline. Export a Markdown bug report for free, or connect Proofline to publish a private report and file a GitHub issue.

Capture the steps to reproduce a bug

Open the side panel, press Record and repeat the steps that trigger the problem. If a Save button spins and nothing happens, capture the screen and add a note about what you expected. A developer can follow the click, see what appeared on the page and check the console logs and network requests around that moment.

Show exactly what went wrong

For visual QA and website feedback, click a page element or draw a rectangle and pin a comment to it. Take a screenshot for a layout bug. Turn on tab video to show a dialog that closes too soon, or add a voice note to explain a sequence that’s hard to describe in writing.

File a GitHub issue with a private report

With the optional Proofline workspace connection, review the issue title and summary, choose a repository and file the ticket. The GitHub issue links to the full report, which requires sign-in. You can also publish the report to Proofline on its own so a teammate can review the evidence before you file. The issue title and body follow the repository’s visibility settings.

Export a bug report without an account

Local recording and export need no account or API key. Choose how much detail to include, then download a ZIP with report.md and its attachments. Attach it to an existing support ticket, hand it to an engineer investigating a regression, or give the Markdown to a coding agent.

Choose what you share

Recordings stay in Chrome until you export them or use an optional integration. Configured AI summaries send text evidence to the selected provider. Transcription sends audio. Review screenshots, video, audio and notes before sharing, especially if you recorded customer data. The Proofline connection is in preview. Optional provider and hosting charges may apply.

See a worked bug report: https://proofline.sh/session-recorder-chrome-extension/example-report/
Help and setup: https://proofline.sh/help/session-recorder/

## Single purpose

Record a web-app session and turn its evidence into a debugging report. Capture, annotation, transcription, report export and issue filing support that purpose.

## Permission justifications

| Permission | Purpose |
| --- | --- |
| `debugger` | Capture network request/response details, console messages, exceptions and screenshots through CDP. Chrome shows its debugger banner while attached. |
| `<all_urls>` | Record the web application the user selects; the application domain is not known in advance. |
| `tabs`, `webNavigation` | Track recorded tabs and page/SPA navigation. |
| `scripting` | Activate interaction, annotation and file capture content scripts. |
| `storage`, `unlimitedStorage` | Persist settings, sessions, events and assets locally. |
| `sidePanel` | Present recording controls and session list. |
| `offscreen` | Record microphone and tab media in an offscreen document. |
| `tabCapture` | Record the selected tab's video and sound when enabled. |
| `downloads` | Save exported report ZIPs. |
| `alarms` | Flush buffered capture events during recording. |

## Privacy disclosures

Use [PRIVACY.md](PRIVACY.md) and the actual package to complete the dashboard form. Do not reuse the old “no server you control” answer for a release with managed Proofline services enabled.

- Captured website content can include personal or sensitive information. Redaction reduces exposure; it does not justify declaring those data categories impossible.
- Audio and tab video are captured only when enabled.
- Personal transcription sends audio to the selected provider. Personal AI sends text to the configured provider; vocabulary extraction can include bounded visible page labels.
- Managed AI sends relevant text or audio through Proofline to configured providers. Usage is recorded against the selected workspace.
- Publishing sends the report and included assets to Proofline or the user's Cloudflare account. GitHub receives the issue title, summary and report link.
- Credentials stay in trusted extension storage and are sent to their configured service; they are not report attachments.
- The extension has no advertising or analytics and does not sell recorded data. It does transmit data to optional processing services, so do not describe all third-party sharing as absent.
- Extension code is bundled locally. Provider responses are data, not remotely executed extension code.

## Assets and release

Upload the four 1280 × 800 TodoMVC PNGs in [design/store](../design/store/) in filename order: record, annotate, timeline, export. Set the English promotional video to https://www.youtube.com/watch?v=LbEPAIOUPkM. The film shows the released extension in a demo workspace with simulated publication and filing responses.

The release workflow attaches `session-recorder.zip` and its SHA-256 checksum to a published GitHub release. The stable asset path is `https://github.com/prooflinedev/session-recorder-chrome-extension/releases/latest/download/session-recorder.zip`; it works only after a release containing that asset exists. After validating the version and package, the workflow submits that same ZIP to Chrome Web Store for review using the configured publisher account. See [Chrome Web Store publishing](chrome-store-publishing.md) for account setup, version tags and recovery; submission does not mean Google has approved the update.
