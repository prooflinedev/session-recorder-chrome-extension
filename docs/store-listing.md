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

Record browser bugs with screenshots, console errors, and network requests. Export a Markdown report or file a GitHub issue.

## Detailed description

Record the steps that trigger a browser bug. Mark the element that went wrong, then review your clicks, screenshots, console errors and network requests on one timeline. Download the report as Markdown with its attachments. Recording and local export are free and need no account or API key.

Point out what happened

Click a page element or draw a rectangle and attach a comment. Add a screenshot, type a note, or turn on the microphone to narrate the steps. Your annotations stay beside the actions they describe.

Hand the report to a developer

Choose Full, Standard, Compact or Minimal detail and download the ZIP. A teammate can open report.md or give it to a coding agent. To see an actual report before installing, visit https://proofline.sh/session-recorder-chrome-extension/example-report/.

File a GitHub issue

Connect a repository and configure protected publishing to file issues from a recording. With an AI provider configured, you can review and edit the summary before filing. A private report link still leaves text filed in a public GitHub issue visible to everyone.

Choose what leaves your browser

Recordings stay in Chrome until you export them or use an optional service. Transcription sends audio to the provider you choose. AI summaries send text evidence. Publishing uploads the report and its attachments. Review screenshots, audio and free text before sharing because they can contain private information. Provider and hosting charges may apply.

The optional Proofline workspace connection is in preview. Source code and support are available at https://github.com/prooflinedev/session-recorder-chrome-extension.

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

Use screenshots of the package being submitted. [`docs/screenshots/`](screenshots/) contains the documentation captures; [`design/store/`](../design/store/) contains store-sized assets. Recheck older store images against the new branding and live-annotation UI before upload. Do not present mock account balances or fabricated bug reports as real customer data.

The release workflow attaches `session-recorder.zip` and its SHA-256 checksum to a published GitHub release. The stable asset path is `https://github.com/prooflinedev/session-recorder-chrome-extension/releases/latest/download/session-recorder.zip`; it works only after a release containing that asset exists. After validating the version and package, the workflow submits that same ZIP to Chrome Web Store for review using the configured publisher account. See [Chrome Web Store publishing](chrome-store-publishing.md) for account setup, version tags and recovery; submission does not mean Google has approved the update.
