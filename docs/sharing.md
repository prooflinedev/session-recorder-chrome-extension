# Publish a protected report and create a GitHub issue

Open a stopped session and choose **File issue**. Publishing and AI summaries are optional. Local ZIP export
continues to work without any keys or accounts.

## Proofline setup

Connecting Proofline uses workspace credits for all AI, private report hosting and GitHub App issue filing. Standalone recording, personal provider keys and Cloudflare publishing remain available when disconnected.

In Settings → Proofline, choose Connect to Proofline and approve the code in your browser. Your personal workspace is selected by default when eligible. All services use the connected workspace automatically, including previously saved connections. Settings shows Using Proofline instead of manual provider setup or overrides. Personal credentials remain stored locally for use after disconnecting.

The workspace selector chooses whose credits pay for AI. Switching workspaces requires browser approval. The existing 10,000-credit grant requires Proofline onboarding and GitHub App installation; sign-in alone does not grant credits. If credits run out, top up or disconnect to use personal keys. Local recording and manual annotations remain available.

Proofline keeps provider keys on the server. It meters summaries, session titles, page vocabulary and transcription. Model selection is automatic and cannot be overridden while connected. When configured, managed dictation transcribes short audio segments using Deepgram or ElevenLabs. Personal-key mode retains direct streaming.

Reports are private to their creator until readers are selected. Invited outside readers require a free Proofline account. Reports remain until deleted, subject to workspace storage limits. The extension uploads Markdown and attachments rather than executable HTML. Each attachment is limited to 25 MB. Upload and issue request identifiers are saved before submission so retries resume their original requests.

The repository dropdown lists repositories available through the selected workspace’s GitHub App installation. Managed issue creation requires Proofline hosting. Disconnect Proofline to use Cloudflare hosting and personal repository tokens. Existing Cloudflare reports remain at their original destination.

## Cloudflare setup

1. Create a dedicated **Direct Upload** Cloudflare Pages project. Its initial
   production deployment should contain only an empty placeholder, never a report.
2. In Pages → Settings → General, enable the preview Access policy.
3. In Zero Trust → Access → Applications, configure that application for
   `*.<actual-project-hostname>.pages.dev`, with no path restriction or public path
   overrides. If Cloudflare assigned a suffix to your project hostname, include it.
4. Add an **Allow** policy for the people who should read reports. Choose email
   one-time PIN or an identity provider configured in your Cloudflare account.
   Remove Bypass and Service Auth policies from this application.
5. In extension Settings → Publishing, enter your account ID and use
   **Create a preconfigured API token**. The link requests **Cloudflare Pages:
   Edit** and **Access: Apps and Policies: Read**. Review the account scope and
   create the token. It does not create a token without your approval in Cloudflare.
   Use an API token, not your Global API Key.
6. Enter the token, Pages project name, Access **application ID** (UUID, not AUD),
   and team domain (`your-team.cloudflareaccess.com`). Choose **Verify Access &
   save**. The audience is read from the Access application automatically.

The extension publishes a unique **preview** branch per report and links the
immutable deployment URL. It does not replace earlier reports or publish sessions
at the production/custom domain. Every deployment includes an advanced-mode
Pages Function that validates Access's RS256 JWT signature, issuer, audience and
expiry before serving any HTML, image, recording or download. Publishing sets the
production and preview Functions configurations to **fail closed**. Access performs login; the
Function prevents a missing/bypassed Access rule from exposing report data.

Readers must be permitted by your Access policy. A 403 instead of the login page
usually means the hostname/policy is wrong or has not propagated yet. Check the
wildcard application and team domain. Changing the Access application or team
domain requires republishing because each deployment pins its issuer and audience.
The extension does not automate identity-provider setup or grant readers access.
Reports use Pages Functions requests; Cloudflare account limits and billing apply.

## AI summary setup

In **Settings → AI summaries**, choose OpenAI, OpenAI compatible, Anthropic or Google
Gemini, enter your API key and a model ID available in your account. Each provider
keeps its own configuration. For OpenAI-compatible servers, set the API base URL
(including `/v1` if required). HTTPS is required except for localhost; a local
server may leave the key blank. The compatible endpoint must support Chat
Completions. Official providers use their native authentication and APIs.

**File GitHub issue** generates the summary automatically when a model API is configured. It sends at most 60,000 characters of compact text evidence directly to the selected provider. Annotations lead, then notes and narration, then interactions; repeated diagnostics are condensed and kept separate. Titles and summaries reflect the reporter’s concerns, including improvement requests, rather than unrelated console noise. Screenshots, files and audio/video bytes are not sent to the model. The exact input is available under **Review text sent to the model**. Provider charges may apply.

With a configured model, stopping a recording also sends this bounded evidence to generate a short title for the Sessions list. The report opens immediately and the list updates when the name is ready. Failed naming leaves the original title intact; late responses cannot overwrite manual renames or restore deleted sessions.

Edited or previously generated drafts are preserved. **Regenerate summary** explicitly replaces them. Without a model configuration, you can write the issue yourself.

## GitHub setup

In **Settings → GitHub**, choose **Add repository** and enter a repository and its GitHub API token. Repeat for other destinations. The token creation link preselects **Issues: Read and write** and the resource owner; select only the repository you want to use. Saving checks access to each configured repository. Tokens stay in trusted extension storage and are never exported. Existing single-repository settings migrate automatically. See [GitHub issue creation permissions](https://docs.github.com/en/rest/issues/issues#create-an-issue).

## File an issue

Choose **File GitHub issue**. The extension generates the summary if configured, publishes the protected report, creates the actual issue, and opens it. No review checkbox or second submission is required. The local report, file list, editable draft, and **Publish report only** remain available.

The arrow beside **File issue** selects a configured repository and its matching credential. New reports use the last selection; existing drafts retain their destination. A full-page progress screen shows the current stage and offers **Cancel**. Cancellation preserves saved drafts and deployments and stops further work, but cannot undo an upload or issue request already accepted by the service. An uncertain issue request stays tied to its original repository for reconciliation.

The GitHub summary has the repository’s visibility, independent of Access. Keep the share tab open while it works. Each file must be at most 25 MiB and the bundle at most 20,000 files. Compact and Minimal omit video.

Proofline may queue issue creation while GitHub rate limits reset. The filing screen distinguishes a queued request from submission to GitHub. After one minute of polling, it returns to the draft with a message that processing continues in the background. Use **Check GitHub issue** later to check that same request; filing another issue manually can create a duplicate.

Created issues and in-flight attempts are saved locally. Reopening a completed report shows **View issue**. A retry reuses an existing deployment and checks for an accepted GitHub request before any resubmission. An uncertain GitHub response never causes an automatic duplicate POST; **Check GitHub issue** reconciles the previous request.

Drafts and deployment IDs persist locally. **Check deployment** resumes polling
after a timeout without another upload. If a network failure occurs during the
deployment-creation request itself, check the Cloudflare dashboard before retrying:
the response may have been lost after Cloudflare created the deployment.
**Unpublish report** deletes that deployment and leaves the local recording.
Deleting local recordings does not delete previously published reports; remove
those in the share tab first or in Cloudflare. Unpublishing cannot revoke copies
already downloaded by readers, and it does not delete GitHub issues.

## Implementation and verification

`lib/sharing/` owns provider adapters, Pages uploads, Access verification, hosted
rendering, configuration and GitHub handoff. Provider keys are in a separate
`chrome.storage.local` record, restricted to trusted extension contexts; they are
never added to session settings or exports. The deployed Function contains only
public issuer/audience identifiers, never API credentials. Hosted content is
sanitized, uses same-origin assets, disables scripts and caching, and serves
captured files as downloads.

The share view and settings view use reducers and dedicated hooks. Effects only
own initial loading and browser subscriptions; edits, preparation, persistence
and network operations run through explicit actions. Ordered writes prevent draft
edits from overwriting saved deployment metadata.

Tests cover provider protocols, bounded evidence, unsafe destinations, publishing
preconditions, generated deployment contents, signed and forged Access tokens,
hosted HTML sanitization, persistence and the browser flow using mocked services.
Live deployment requires the user's configured Cloudflare account and API keys.

References: [Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/),
[preview Access policies](https://developers.cloudflare.com/pages/configuration/preview-deployments/),
[token template links](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/),
[Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
[Pages API](https://developers.cloudflare.com/api/resources/pages/).

## Live page annotations

While recording, toggle **Annotate**. Click a highlighted element or drag a freeform rectangle to select an area. Type in the anchored comment bar and press Enter or the check button to save. Shift+Enter adds a line. When the recording microphone is on, speech fills the active comment using your configured transcription provider. The comment mic button starts or stops that microphone. With a model configured, visible page labels supply unusual terms to Deepgram or ElevenLabs; form values and hidden content are excluded. The report keeps the comment, element description and screenshot. Click **Turn off annotations** or toggle **Annotate** again to resume normal page interaction. Escape backs out of a comment, then turns annotation off. Pausing or stopping clears annotation mode. **Markup** still opens the separate screenshot drawing editor.

Settings have dedicated Capture, Privacy, Transcription, Publishing, AI summaries, GitHub and Storage pages, with hash links and browser Back navigation.

Stopping opens the report-first workspace. **File issue** stays in the header; evidence appears below the draft, and technical events and report options stay collapsed. **Full timeline** opens all captured events and download tools. The panel, settings and report follow system light/dark appearance.
