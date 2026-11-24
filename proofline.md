# Proofline Internship Application and Session Recorder Contribution

## Project Context, Development Guide, Investigation Strategy, and Contribution Objectives

**Prepared for:** Mandeep Yadav
**Target role:** Software Engineering Intern, Developer Tools
**Company:** Proofline
**Selected open-source repository:** [prooflinedev/session-recorder-chrome-extension](https://github.com/prooflinedev/session-recorder-chrome-extension)
**Primary coding environment:** Local macOS development environment
**Intended coding assistant:** Codex or another coding agent
**Document purpose:** Provide complete project context and instructions for understanding, testing, investigating, and contributing to Proofline's Session Recorder Chrome extension.

---

# 1. Executive Summary

I am preparing an application for the Software Engineering Intern, Developer Tools position at Proofline.

As part of the application, Proofline asks candidates to make a meaningful contribution to one of its open-source developer tools. After exploring the available repositories and understanding the products, I selected the **Session Recorder Chrome extension**.

I have cloned the repository and installed the project on my local machine. I have also installed the extension locally in Chrome.

My immediate objective is not to start coding a random feature. It is to understand the product, explore its functionality, run it locally, test its different workflows, inspect its implementation, and identify a genuine problem or worthwhile improvement.

The final objective is to make a meaningful engineering contribution, verify it properly, submit a pull request to Proofline's original GitHub repository, and use Proofline's own review system to review my contribution.

The contribution should demonstrate that I can:

- Understand an existing software product.
- Navigate an unfamiliar codebase.
- Identify real engineering problems.
- Investigate and reproduce bugs.
- Understand frontend and backend-facing workflows.
- Write maintainable TypeScript code.
- Test changes properly.
- Use AI coding tools responsibly.
- Explain my technical decisions.
- Verify that the implementation actually works.

**Most important principle: Do not start with the question, "What feature can I add?" Start with, "What problem exists, why does it matter, and how can I prove it?"**

---

# 2. Why Proofline?

## 2.1 Understanding the company

Proofline is building an evidence-first production agent for cloud infrastructure.

Its product focuses on helping engineering teams understand whether infrastructure and software changes are safe, whether deployments have succeeded, and why something may have failed.

It works with cloud platforms such as:

- Amazon Web Services (AWS)
- Google Cloud Platform (GCP)
- Microsoft Azure

The broader product combines software engineering, cloud infrastructure, production observability, and AI-assisted investigation.

Its developer tools include:

- Command-line interface (CLI).
- Python SDK.
- TypeScript SDK.
- Chrome Session Recorder extension.
- Other developer integrations and tools.

The important idea behind Proofline is that AI should not simply make confident statements. It should investigate available evidence and support its conclusions.

For example, instead of an AI agent simply saying:

"Your deployment failed because of a configuration problem."

A useful production agent should be able to investigate:

- What changed in the code?
- What infrastructure configuration changed?
- What happened during deployment?
- What do the logs indicate?
- What do the metrics indicate?
- Which evidence supports the conclusion?

This evidence-first approach is one of the most interesting aspects of the company.

## 2.2 Why this company is interesting to me

I am interested in Proofline because its work sits at the intersection of several areas I want to develop professionally:

1. Software engineering.
2. Developer tools.
3. Cloud infrastructure.
4. Debugging and production reliability.
5. AI-assisted engineering.
6. Open-source development.

I do not want to contribute to a repository just to have another GitHub contribution on my profile.

I want to understand how a real developer-facing product works, identify a problem that matters to its users, and contribute an improvement that can be tested and reviewed.

Proofline's emphasis on evidence, verification, and engineering correctness makes it a particularly interesting environment for this kind of contribution.

## 2.3 Why the Developer Tools internship?

The position is Software Engineering Intern, Developer Tools.

The role involves working directly with the founder and contributing to actual developer-facing products.

The company encourages candidates to use AI coding tools, but the important expectation is that candidates understand the generated code, verify their work, and explain their decisions.

This matches the way I want to approach engineering:

- Use AI to accelerate exploration and implementation.
- Understand the architecture before modifying it.
- Investigate problems rather than guess.
- Write tests for meaningful changes.
- Verify behavior instead of trusting generated code.
- Take responsibility for the final implementation.

I see this opportunity as a chance to demonstrate practical engineering ability through a real open-source contribution.

---

# 3. My Existing Engineering Background

I am not approaching this as someone who has never built software.

My previous experience includes working as a Founding Software Engineer Intern at Athletesbnb / RLXED.

I worked on building and shipping RLXED end-to-end, including an Expo/React Native athlete application that reached production on both the Apple App Store and Google Play Store.

My experience includes working with technologies such as:

### Frontend and application development

- JavaScript.
- TypeScript.
- React.
- React Native.
- Expo.

### Backend development

- Node.js.
- Express.js.
- PostgreSQL.
- Redis.
- BullMQ.
- REST APIs.
- Authentication systems.

### Infrastructure and delivery

- AWS.
- AWS SES.
- Docker.
- CI/CD.
- Production monitoring.

### Additional experience

- AI integrations.
- API integrations.
- Application architecture.
- Building and shipping production software.

This experience is relevant because Session Recorder is also a real product with frontend interfaces, asynchronous workflows, browser APIs, data persistence, and integrations.

However, I should not assume that understanding React Native or ordinary web development automatically means I understand Chrome extension architecture.

I need to learn the browser-specific parts of this repository properly.

---

# 4. The Internship Application Assignment

Proofline's application assignment has several parts.

## 4.1 First: Make an open-source contribution

Proofline offers two alternative approaches.

### Option A: AI Review Benchmarks

Repository:

[https://github.com/prooflinedev/ai-review-benchmarks](https://github.com/prooflinedev/ai-review-benchmarks)

This involves running multiple AI code reviewers against the same pull request and evaluating:

- What each reviewer identifies.
- What each reviewer misses.
- Whether the findings are accurate.
- Whether the findings are supported by actual evidence.
- Which reviewer provides more useful feedback.

This is a benchmarking and evaluation-oriented contribution.

### Option B: Contribute to a developer tool

Candidates can select one of Proofline's developer-tool repositories:

| Repository       | Main purpose                                |
| ---------------- | ------------------------------------------- |
| CLI              | Command-line interaction with Proofline     |
| Python SDK       | Programmatic access through Python          |
| TypeScript SDK   | Programmatic access through TypeScript      |
| Session Recorder | Browser session recording and bug reporting |

The candidate must identify a meaningful feature or substantial bug fix.

Documentation-only or cosmetic changes are not sufficient.

## 4.2 My selected approach

I selected Option B: contribute to an existing developer tool.

More specifically:

**Session Recorder Chrome extension.**

Repository:

[https://github.com/prooflinedev/session-recorder-chrome-extension](https://github.com/prooflinedev/session-recorder-chrome-extension)

This is the repository I have already cloned and installed locally.

I have not yet selected a specific feature or confirmed a bug.

That decision must come from actual product exploration and code investigation.

## 4.3 Second: Use Proofline to review my contribution

Regardless of which first-step approach a candidate chooses, the assignment also requires installing Proofline on their own GitHub organization and running a real review of their work.

I will need to:

1. Prepare my contribution.
2. Open a pull request.
3. Install and configure Proofline for the relevant GitHub organization.
4. Run a review of my pull request.
5. Examine the findings.
6. Decide which findings are valid.
7. Accept useful recommendations.
8. Explain why any recommendations are rejected or considered incorrect.

The goal is not to blindly accept every AI recommendation.

The goal is to demonstrate that I can evaluate AI-generated code review feedback critically.

## 4.4 Third: Submit a pull request

The pull request should explain:

- The problem.
- Why the problem matters.
- The approach taken.
- The implementation.
- Tests performed.
- End-to-end verification.
- Reproducible steps.
- Results.

The pull request should be ready for review.

It does not necessarily need to be merged.

## 4.5 Fourth: Record a short walkthrough

A narrated screen recording of no more than two minutes is required.

It should demonstrate:

1. The original problem.
2. The change I implemented.
3. The important code changes.
4. How I tested the implementation.
5. Why I chose this solution.

The walkthrough should be concise and technically clear.

## 4.6 Fifth: Email the application

Email:

[intern-applicants@proofline.sh](mailto\:intern-applicants@proofline.sh)

Subject:

Software Engineering Intern

The email should include:

- A short introduction.
- My location.
- My full-time availability for 3–6 months.
- The pull request link.
- The narrated video link.

The application should communicate what I built, why I built it, and how I verified it.

---

# 5. Why I Selected Session Recorder

Session Recorder is a free, open-source Chrome extension designed to capture browser activity and turn it into a detailed, developer-friendly bug report.

Its main purpose is:

**Record a browser bug, point out what went wrong, and file a GitHub issue with the evidence attached.**

I selected it because it is a real developer-facing product with multiple interesting engineering components.

It is not just a simple Chrome popup.

It includes:

- Browser event capture.
- Chrome extension APIs.
- Network inspection.
- Console error capture.
- Screenshot capture.
- Video recording.
- Audio recording.
- Annotation tools.
- Local data storage.
- Report generation.
- Data export.
- AI integrations.
- GitHub issue creation.
- Cloud report publishing.
- Privacy and redaction mechanisms.

This creates opportunities to understand different engineering challenges within one repository.

## 5.1 Why this repository fits my experience

The project uses technologies and concepts that overlap with my existing experience:

- React and TypeScript.
- UI development.
- Asynchronous operations.
- State management.
- Data handling.
- API integrations.
- Error handling.
- Production-oriented testing.

At the same time, it introduces new technical areas:

- Chrome Manifest V3.
- Browser extension architecture.
- Chrome Debugger Protocol.
- Browser lifecycle events.
- Background service workers.
- IndexedDB.
- Offscreen documents.
- Browser media capture.
- Playwright extension testing.

This makes it a useful opportunity to expand my engineering knowledge.

## 5.2 Why I prefer a product-facing contribution

I want my contribution to improve something that an actual user interacts with.

For example, if a recording fails to capture a certain event, the user may lose important debugging evidence.

If an annotation is not saved correctly, the developer may not understand the original problem.

If a report export silently loses important information, the resulting report may become less useful to a coding agent.

These are examples of possible investigation areas, not confirmed defects.

I should only propose a fix after verifying that a real issue exists or identifying a clearly justified missing capability.

---

# 6. Understanding Session Recorder

Before contributing, I need to understand what the extension actually does.

The product follows a general workflow:

**Record → Annotate → Review → Export or File Issue**

## 6.1 Recording

The user opens a web application and starts recording through the extension.

During the session, the extension can capture:

- Clicks.
- Inputs.
- Navigation.
- Tab activity.
- Console messages.
- JavaScript exceptions.
- Network requests.
- Network responses.
- Screenshots.

Recording can also include optional:

- Microphone narration.
- Tab video and audio.
- Uploaded files.
- Markers.
- Notes.

The extension can follow tabs opened by the recorded application.

The goal is to capture enough context to explain what happened during a browser session.

## 6.2 Annotation

Sometimes a developer cannot explain a visual problem clearly through text alone.

Session Recorder provides annotation functionality.

A user can:

- Select an element on a webpage.
- Drag a rectangle around an area.
- Add a comment.
- Annotate a screenshot.
- Add arrows, boxes, or text.
- Dictate a comment.
- Attach additional context.

For example:

A user visits an e-commerce application and notices that a discount is applied incorrectly.

Instead of writing a long explanation, they can select the incorrect total and annotate it.

The resulting report includes that visual evidence.

## 6.3 Reviewing the report

After stopping the recording, the user can open the full session report.

The report brings together:

- Browser interactions.
- Screenshots.
- Annotations.
- Console messages.
- Network activity.
- Narration.
- Notes.
- Other captured evidence.

This makes the report more useful than a collection of unrelated screenshots and text messages.

## 6.4 Exporting the report

The extension can export the session as a ZIP archive.

The ZIP contains `report.md` and supporting assets.

Depending on the recording, it can also contain `network.har`.

The Markdown report can be provided to:

- Claude Code.
- Codex.
- Cursor.
- ChatGPT.
- Other coding agents.

The coding agent can use the evidence to investigate the issue.

The extension offers different export detail levels:

- Full.
- Standard.
- Compact.
- Minimal.

This helps control the amount of evidence included in the exported report.

## 6.5 Filing a GitHub issue

The extension can also create a GitHub issue from a recording.

The general workflow is:

1. Configure a GitHub repository.
2. Configure report hosting and an AI provider if needed.
3. Record a browser session.
4. Review the generated report.
5. Select File issue.
6. Review the issue draft.
7. Publish the report and create the issue.

AI is optional. The issue draft can also be edited manually.

## 6.6 Integrations

Session Recorder supports different service configurations.

| Capability             | Supported services or setup                            |
| ---------------------- | ------------------------------------------------------ |
| AI summaries           | OpenAI, OpenAI-compatible endpoints, Anthropic, Google |
| Voice transcription    | Deepgram, ElevenLabs, OpenAI-compatible transcription  |
| Private report hosting | Cloudflare Pages with Cloudflare Access                |
| GitHub issues          | Repository-specific GitHub access                      |
| Managed integration    | Optional Proofline connection                          |

Provider and hosting charges may apply when using external services.

Recording, annotations, and local ZIP export can work without an account or API key.

The optional Proofline connection uses Proofline workspace credits for its managed AI and publishing functionality.

---

# 7. Technical Architecture

Session Recorder is a Chrome Manifest V3 extension built with:

- WXT.
- React.
- TypeScript.

Its architecture is different from a conventional React web application because it interacts with Chrome's extension APIs and browser lifecycle.

## 7.1 Important concepts

### Chrome Manifest V3

Manifest V3 is the modern Chrome extension platform.

It defines:

- Extension permissions.
- Background service workers.
- Content scripts.
- Extension pages.
- Browser API access.

The extension uses a generated manifest configuration.

### Background service worker

The background component coordinates important extension operations.

It handles session lifecycle, event ingestion, capture coordination, and runtime messages.

It acts as a central coordination point.

### Content scripts

Content scripts interact with webpages.

They can help capture browser interactions and display annotations over the page.

They communicate with the background component using typed messages.

### IndexedDB

IndexedDB is a browser database.

Session Recorder uses it to store recording data and larger assets locally.

It is important because recordings can contain significantly more information than a simple browser settings object.

### Chrome Debugger Protocol

The extension uses the Chrome debugger API to capture information such as:

- Network requests.
- Network responses.
- Console messages.
- Exceptions.
- Screenshots.

Chrome displays a debugger notification while deep capture is active.

### Offscreen documents

An offscreen document allows the extension to perform certain DOM and media operations outside its visible extension interface.

The project uses this area for microphone and tab-video recording.

### Playwright

Playwright is used for browser automation and end-to-end testing.

It can launch an isolated Chromium environment, load the built extension, interact with it, and verify the results.

---

# 8. Repository Structure and Code Map

The following code map comes from the repository's current `DEVELOPMENT.md`.

I should inspect the actual files in my cloned version before assuming that every implementation detail is unchanged.

| Path                          | Responsibility                                                             |
| ----------------------------- | -------------------------------------------------------------------------- |
| `entrypoints/background.ts`   | Session lifecycle, event ingestion, capture coordination, runtime messages |
| `entrypoints/*.content.ts`    | Interactions, files, live annotations, screenshot annotation               |
| `entrypoints/sidepanel/`      | Recording controls, session list, shared settings                          |
| `entrypoints/options/`        | Full-page settings                                                         |
| `entrypoints/share/`          | Issue draft, evidence, repository picker, filing progress                  |
| `entrypoints/report/`         | Local report and export                                                    |
| `entrypoints/offscreen/`      | Microphone and tab-video recording                                         |
| `entrypoints/mic-permission/` | Microphone permission flow                                                 |
| `lib/session/`                | Session and event types, defaults, importance, protected signals           |
| `lib/capture/`                | Debugger, console, network, screenshots, tabs, redaction                   |
| `lib/annotations/`            | Annotation state, overlays, dictation, page vocabulary                     |
| `lib/storage/`                | IndexedDB and batched event writes                                         |
| `lib/export/`                 | Trimming, Markdown/HTML, token estimates, OpenAPI, ZIP bundles             |
| `lib/sharing/`                | AI summaries, publishing, GitHub issues                                    |
| `lib/proofline/`              | Device authorization, managed AI, reports, service settings                |
| `lib/transcription/`          | Provider adapters, streaming, keyterms, PCM conversion                     |
| `e2e/`                        | Browser fixtures and end-to-end tests                                      |
| `demo/`                       | Local capture test page                                                    |

## 8.1 Important architectural rule

The project uses a central event funnel.

Capture sources feed events into the background component.

The background component assigns event identity and timestamps before storing them in IndexedDB.

Content scripts communicate using typed messages.

Large assets should be stored in IndexedDB rather than passed through Chrome messages.

This architecture is important when investigating bugs involving event ordering, persistence, missing data, or communication between extension components.

## 8.2 Architectural boundaries to respect

- Keep UI state in focused hooks and reducers.
- Use effects to synchronize browser lifecycle and external storage.
- Keep user-requested work in appropriate event handlers.
- Keep export transformations pure where possible.
- Preserve the session event contract.
- Do not pass provider credentials into content scripts.
- Do not silently fall back from exhausted Proofline credits to personal API keys.
- Preserve cancellation and retry behavior in issue filing.
- Never treat client-side checks as server-side authorization.

A change that ignores these boundaries may appear to work in one screen while breaking another workflow.

---

# 9. Current Local Development Environment

## 9.1 What has already been completed

The following work has already been done:

- [x] Selected the Session Recorder repository.
- [x] Cloned the repository locally.
- [ ] Installed the project dependencies.
- [ ] Installed the extension locally in Chrome.

The following work is still pending:

- [ ] Confirm the installed Node.js and pnpm versions.
- [ ] Confirm the current local build works.
- [ ] Run the project test suite.
- [ ] Understand the complete recording workflow.
- [ ] Explore annotations and reports.
- [ ] Explore exports and integrations.
- [ ] Inspect the architecture and tests.
- [ ] Identify a genuine problem or useful improvement.
- [ ] Implement and verify the contribution.
- [ ] Open a pull request.
- [ ] Review the pull request using Proofline.
- [ ] Record the final walkthrough.
- [ ] Send the application email.

Do not assume a step is complete just because a command was attempted. Record its actual result.

## 9.2 Check the environment

Open Terminal from the repository root.

Run:

```bash
node -v
pnpm -v
git status
```

The official development guide specifies Node.js 22 and the pnpm version declared in `package.json`.

Check the project's package configuration:

```bash
cat package.json
```

Do not upgrade dependencies or change package versions just to make the project look current.

## 9.3 Install dependencies

If dependencies have already been installed, do not unnecessarily repeat this.

For a clean dependency installation:

```bash
pnpm install --frozen-lockfile
```

This respects the versions recorded in the lockfile.

## 9.4 Start the development server

```bash
pnpm dev
```

This starts the WXT development server.

Follow the terminal output and use the development build location it reports.

## 9.5 Build the extension

```bash
pnpm build
```

The production build is generated in:

```text
.output/chrome-mv3
```

## 9.6 Load the local build into Chrome

1. Open Chrome.
2. Navigate to `chrome://extensions`.
3. Enable Developer mode.
4. Select Load unpacked.
5. Choose `.output/chrome-mv3`.
6. Pin the extension if necessary.
7. Open it from the toolbar.

If the extension is already loaded from the same directory, use the Reload button after rebuilding.

Important: Chrome can associate local extension storage with the unpacked extension's directory identity. Repeatedly loading different build directories can result in separate extension identities and separate local settings or recordings.

Stop active recordings before reloading the extension.

## 9.7 Important development commands

These are the current commands documented by the repository:

```bash
pnpm dev
pnpm build
pnpm zip

pnpm compile
pnpm compile:e2e

pnpm test:unit

pnpm exec playwright install chromium

pnpm test:e2e
pnpm test:e2e:headed

pnpm test
```

Their general purpose:

| Command                | Purpose                            |
| ---------------------- | ---------------------------------- |
| `pnpm dev`             | Start WXT development mode         |
| `pnpm build`           | Build the extension                |
| `pnpm zip`             | Package the extension              |
| `pnpm compile`         | Type-check extension TypeScript    |
| `pnpm compile:e2e`     | Type-check browser-test TypeScript |
| `pnpm test:unit`       | Run Vitest unit tests              |
| `pnpm test:e2e`        | Run Playwright end-to-end tests    |
| `pnpm test:e2e:headed` | Run visible browser tests          |
| `pnpm test`            | Run the main verification suite    |

The main CI check uses `pnpm test`. It includes Vitest, browser-test TypeScript checks, an extension build, and the full Playwright suite.

The end-to-end tests use an isolated Chromium profile and the bundled `demo/` page.

The test environment uses synthetic audio and video devices. Automated sharing tests use network fixtures to avoid creating real GitHub issues or reports.

## 9.8 Focused test example

A focused browser test can be run with:

```bash
pnpm exec playwright test e2e/proofline.spec.ts
```

Use focused tests while investigating a specific component, then run the broader checks affected by the change.

---

# 10. How I Should Explore the Product

Before modifying code, I need to use the extension as an actual user.

The objective is to understand its behavior, discover its boundaries, and find places where the experience or implementation might fail.

## 10.1 Explore the basic recording workflow

Start with the simplest possible scenario.

1. Open a normal webpage.
2. Open Session Recorder.
3. Start a recording.
4. Click a few elements.
5. Type into a field.
6. Navigate to another page.
7. Stop recording.
8. Open the report.
9. Inspect the recorded timeline.

Questions to investigate:

- Were all interactions recorded?
- Are timestamps sensible?
- Does the timeline follow the correct order?
- Is the recorded URL correct?
- Are screenshots associated with the right events?
- Does the report accurately represent the session?

Do not assume that every missing event is a defect. First understand what the capture settings and permissions are supposed to allow.

## 10.2 Explore annotations

1. Start a recording.
2. Enable Annotate.
3. Select a webpage element.
4. Add a comment.
5. Try selecting an area using a rectangle.
6. Try screenshot markup.
7. Stop recording.
8. Inspect the report.

Questions:

- Does the selected element correspond to the correct page element?
- Is the annotation visible in the report?
- Is its timestamp correct?
- Does it remain associated with the right session?
- Does the annotation survive export?

## 10.3 Explore console and network capture

Use a local or harmless test page.

Try scenarios that generate:

- A console message.
- A JavaScript exception.
- A failed HTTP request.
- A successful HTTP request.
- A response with a JSON body.

Then inspect the report.

Questions:

- Were the events captured?
- Are the request and response details accurate?
- Are sensitive values redacted?
- Are failures distinguishable from successful requests?
- Does the report explain capture gaps?

## 10.4 Explore navigation and tabs

Test:

- Navigation within the same tab.
- Single-page application navigation.
- Opening a new tab from the recorded application.
- Returning to the original tab.
- Closing a recorded tab.

Observe whether recording follows the expected navigation behavior.

## 10.5 Explore local storage and export

1. Complete a recording.
2. Open the report.
3. Export at Full detail.
4. Export at Standard detail.
5. Export at Compact detail.
6. Export at Minimal detail.
7. Compare the output.

Check:

- Whether `report.md` exists.
- Whether attachments are present.
- Whether the report is readable.
- Whether important annotations survive trimming.
- Whether errors remain represented.
- Whether `network.har` is present when applicable.
- Whether token estimates are reasonable.

## 10.6 Explore GitHub issue creation

Only configure this after understanding local recording and export.

If using personal GitHub credentials:

- Use a test repository.
- Create a suitably scoped token.
- Do not paste credentials into source code.
- Do not commit credentials or local environment files.
- Avoid creating real issues accidentally during automated tests.

Understand the difference between local report export and publishing a report to an external hosting provider.

## 10.7 Explore privacy and redaction

This is especially important because the product records browser activity.

Test with fictional data:

- A password field.
- An authorization header.
- A token-like string.
- A sensitive URL parameter.
- A request body containing structured sensitive fields.

Verify whether those values are masked in the resulting stored and exported evidence.

Do not use real passwords, personal access tokens, production cookies, or actual customer information during testing.

Remember that pattern-based redaction does not necessarily protect screenshots, video, audio, arbitrary text, or every possible secret.

---

# 11. The Mindset Behind Finding a Contribution

This is the most important part of the project.

I should not enter an open-source repository with a predetermined idea that I must add a particular feature.

I should investigate the existing product and discover where a meaningful improvement is justified.

The process should be:

**Observe → Question → Investigate → Reproduce → Understand → Improve → Verify**

## 11.1 Observe

Use the extension normally.

Pay attention to:

- What the user does.
- What the extension displays.
- What data is captured.
- What happens after stopping.
- What gets stored.
- What gets exported.
- What happens when an operation fails.

The goal is to understand the product before evaluating it.

## 11.2 Question

When something happens, ask why.

Examples:

- Why is this information captured in the background?
- Why does this operation require a permission?
- Why is this data stored in IndexedDB?
- What happens if the user closes a tab during recording?
- What happens if the browser reloads?
- What happens if a network request fails?
- What happens if an annotation is added during a busy recording?
- What happens if a user cancels issue filing?
- What happens if the user exports a very large session?

These questions are investigation prompts, not claims that the extension currently has these defects.

## 11.3 Investigate

Once I have a question, inspect the code.

Look for:

- The relevant component.
- The function handling the operation.
- The event or message flow.
- The data model.
- The storage mechanism.
- The error-handling logic.
- Existing tests.

Understand how the operation is expected to work.

## 11.4 Reproduce

If I suspect a bug, create a repeatable test case.

For example:

1. Start recording.
2. Perform a specific sequence of actions.
3. Trigger a particular condition.
4. Stop recording.
5. Inspect the output.
6. Repeat the test.

A problem that cannot be reproduced is difficult to diagnose and difficult to fix confidently.

## 11.5 Understand the impact

Ask:

- Does this affect real users?
- Does it lose important evidence?
- Does it produce misleading information?
- Does it cause data corruption?
- Does it make the product unreliable?
- Does it affect privacy or security?
- Does it make an important workflow unnecessarily difficult?

A small defect in a critical workflow may be more important than a large cosmetic improvement.

## 11.6 Improve

Only after understanding the problem should I propose an implementation.

The solution should be:

- Focused.
- Consistent with the architecture.
- Maintainable.
- Covered by appropriate tests.
- Compatible with existing workflows.
- Backward-compatible where necessary.

## 11.7 Verify

The final implementation must be tested.

I should be able to demonstrate:

- The original problem.
- The behavior before the fix.
- The behavior after the fix.
- The tests added.
- The relevant test results.
- Any remaining limitations.

A change is not complete just because the code compiles.

---

# 12. Potential Investigation Areas

These are areas worth examining, not confirmed bugs or preselected features.

## 12.1 Recording reliability

Investigate what happens when:

- A user stops recording while events are still being processed.
- A browser tab closes unexpectedly.
- The extension reloads.
- The browser becomes temporarily unavailable.
- Multiple tabs are active.
- A capture source fails to attach.

Important question:

Does the product clearly preserve what it captured and communicate what it could not capture?

## 12.2 Event ordering and timestamps

The product combines events from several capture sources.

Investigate:

- Event ordering.
- Timestamp assignment.
- Duplicate events.
- Delayed events.
- Events arriving after a session has stopped.
- Events associated with the wrong tab.

Important question:

Can the exported report reliably represent the actual sequence of events?

## 12.3 Network capture

Investigate:

- Failed requests.
- Large responses.
- Empty responses.
- Requests without response bodies.
- Redirects.
- Sensitive headers.
- Redaction behavior.
- Capture failures.

Important question:

Does the report accurately describe what happened without claiming to have captured information that was unavailable?

## 12.4 Annotation behavior

Investigate:

- Selecting elements.
- Selecting nested elements.
- Selecting elements that move.
- Annotation persistence.
- Screenshot markup.
- Multiple annotations.
- Annotation export.

Important question:

Does the annotation remain understandable and connected to the original browser state?

## 12.5 Data persistence

Investigate:

- Session creation.
- Event batching.
- IndexedDB writes.
- Large assets.
- Session deletion.
- Storage errors.
- Recovery after interrupted operations.

Important question:

Can the extension preserve a complete and consistent session?

## 12.6 Report generation and export

Investigate:

- Empty sessions.
- Very large sessions.
- Missing attachments.
- Trimming behavior.
- Token estimates.
- Markdown formatting.
- ZIP creation.
- HAR export.

Important question:

Does the exported report preserve the evidence that matters most to a developer or coding agent?

## 12.7 Privacy and security

Investigate:

- Credential redaction.
- Sensitive URL parameters.
- Request and response bodies.
- Custom redaction rules.
- Exported files.
- Local storage.
- External publishing.

Important question:

Could the extension unintentionally expose sensitive information?

## 12.8 GitHub issue creation and publishing

Investigate:

- GitHub authentication failures.
- Invalid repository configuration.
- Upload failures.
- Cancellation.
- Retrying failed operations.
- Duplicate issue creation.
- Expired credentials.
- Partial publishing failures.

Important question:

Does the extension handle failures without losing work or creating duplicate side effects?

---

# 13. How to Inspect the Codebase Efficiently

Use the following commands from the repository root.

## 13.1 Understand the repository

```bash
pwd
git status
git branch --show-current
git log -5 --oneline
```

This establishes:

- The current repository location.
- Whether the working tree is clean.
- The active branch.
- Recent development history.

## 13.2 Inspect available scripts

```bash
cat package.json
```

Understand:

- Build scripts.
- Test scripts.
- Development scripts.
- Dependencies.
- Tooling.

## 13.3 Inspect project documentation

Read these files:

```text
README.md
DEVELOPMENT.md
PLAN.md
IMPLEMENTATION.md
```

Also explore:

```text
docs/
```

Not every document will necessarily exist in the checked-out version. Verify before opening it.

## 13.4 Understand existing tests

Explore:

```text
e2e/
```

And the unit test files throughout the project.

Tests provide useful information about expected behavior.

They can reveal:

- What scenarios the maintainers consider important.
- Which edge cases are covered.
- What the product promises.
- How browser workflows are tested.
- Which failures are expected and handled.

Do not assume that missing test coverage automatically proves a bug.

## 13.5 Inspect recent GitHub activity

Look at:

- Open issues.
- Closed issues.
- Open pull requests.
- Recently merged pull requests.
- Commit history.
- GitHub Actions failures.

This can reveal existing problems, current development priorities, and work that maintainers are already handling.

Do not duplicate an existing issue or submit a change that conflicts with ongoing work.

---

# 14. How to Work With Codex

Codex should be treated as an engineering assistant, not as an autonomous contributor that can make arbitrary decisions.

I want it to help me understand the project, investigate evidence, write code, and verify the results.

I remain responsible for the final technical decisions.

## 14.1 First instruction: Understand the repository

Before asking Codex to implement anything, give it this instruction:

> You are helping me investigate and contribute to Proofline's open-source Session Recorder Chrome extension.
>
> Repository: prooflinedev/session-recorder-chrome-extension.
>
> I have already cloned the repository and installed the project locally.
>
> Do not implement features, modify source files, or make assumptions about bugs yet.
>
> First, inspect the repository's README, DEVELOPMENT.md, package.json, architecture documentation, source structure, and tests.
>
> Explain the architecture in simple but technically accurate language.
>
> Identify the main entry points, background service worker, content scripts, side panel, report workflow, storage implementation, capture modules, export modules, and end-to-end tests.
>
> Explain how a browser interaction becomes a recorded event, how it reaches the background component, how it is stored, and how it eventually appears in an exported report.
>
> Distinguish confirmed facts from assumptions. Refer to actual files and functions.
>
> Do not make code changes.

## 14.2 Second instruction: Understand the product

> Help me understand Session Recorder from a user's perspective.
>
> Trace the complete workflow:
>
> 1. Starting a recording.
> 2. Capturing browser interactions.
> 3. Capturing network and console information.
> 4. Adding annotations.
> 5. Stopping a recording.
> 6. Persisting session data.
> 7. Opening a report.
> 8. Exporting the report.
> 9. Filing a GitHub issue.
>
> For every stage, identify the relevant source files, functions, data structures, and tests.
>
> Do not propose new features yet.

## 14.3 Third instruction: Investigate potential problems

> Now help me identify meaningful engineering improvements in the existing Session Recorder codebase.
>
> Do not invent bugs or suggest random features.
>
> Inspect existing implementation, tests, error handling, and documented behavior.
>
> Look for problems involving reliability, data correctness, recording lifecycle, event ordering, persistence, annotations, export, privacy, or failure recovery.
>
> For every candidate problem:
>
> - Identify the relevant source files.
> - Explain the expected behavior.
> - Explain the actual behavior supported by code or test evidence.
> - Describe how to reproduce the problem.
> - Identify the user impact.
> - Check whether an existing issue or pull request already addresses it.
> - Suggest how it could be tested.
>
> Separate confirmed defects from speculative ideas.
>
> Do not modify files or implement a solution.
>
> Present the strongest candidates and explain which one has the clearest evidence and engineering value.

## 14.4 Fourth instruction: Validate a selected problem

After I select a candidate:

> Help me reproduce and understand this specific issue.
>
> First, inspect the relevant implementation and tests.
>
> Design a minimal reproduction.
>
> Explain the expected and actual behavior.
>
> Run the relevant existing tests.
>
> If necessary, create a focused failing test that demonstrates the problem.
>
> Do not implement the fix until the issue is sufficiently understood.
>
> Do not modify unrelated files.

## 14.5 Fifth instruction: Implement a focused solution

> Implement a focused fix for the confirmed issue.
>
> Follow the repository's architecture and coding conventions.
>
> Keep the change as small as reasonably possible.
>
> Avoid unnecessary refactoring and unrelated modifications.
>
> Add or update tests that demonstrate the original failure and verify the corrected behavior.
>
> Preserve existing functionality and important architectural contracts.
>
> Do not change public interfaces or dependencies unless necessary.
>
> After implementation, explain every modified file and the reasoning behind each change.

## 14.6 Sixth instruction: Verify the change

> Act as a careful reviewer of this implementation.
>
> Review the complete diff.
>
> Look for regressions, incorrect assumptions, race conditions, asynchronous lifecycle problems, error-handling gaps, data loss, privacy issues, and missing tests.
>
> Run the relevant unit tests, type checks, build, and browser tests.
>
> Do not claim that a test passed unless it actually ran successfully.
>
> Report:
>
> - Commands executed.
> - Test results.
> - Files changed.
> - Remaining limitations.
> - Any concerns that still need attention.
>
> Do not modify the code during this review unless I explicitly approve a correction.

---

# 15. Rules for AI-Assisted Development

The use of AI is encouraged, but code quality and engineering judgment remain my responsibility.

Follow these rules throughout the project.

1. Never invent a repository function, file, dependency, or API.
2. Always inspect the existing implementation before changing it.
3. Never assume a suspected bug is real without evidence.
4. Do not rewrite large modules for a small improvement.
5. Do not add unnecessary dependencies.
6. Do not disable tests to make the build pass.
7. Do not weaken privacy or security behavior.
8. Do not expose API keys or credentials.
9. Do not commit `.env` files or personal credentials.
10. Do not make unrelated formatting changes.
11. Do not silently change existing product behavior.
12. Do not claim tests passed when they were not run.
13. Do not accept every AI-generated code review comment automatically.
14. Explain important implementation decisions.
15. Keep the final change focused and reviewable.

**AI can help write the code, but I must understand and defend the code.**

---

# 16. Choosing the Right Contribution

A meaningful contribution does not have to be a massive feature.

A focused, well-tested bug fix can be more valuable than an unnecessarily large feature.

Evaluate candidate work using these criteria:

| Criterion       | Question                                                        |
| --------------- | --------------------------------------------------------------- |
| Real problem    | Does this solve an actual user or developer problem?            |
| Evidence        | Can I demonstrate that the problem exists?                      |
| Reproducibility | Can another developer reproduce it?                             |
| Impact          | Does it affect reliability, correctness, privacy, or usability? |
| Scope           | Can the solution remain focused?                                |
| Testability     | Can I prove that the fix works?                                 |
| Architecture    | Does it fit the existing design?                                |
| Maintainability | Will future contributors understand it?                         |

The best contribution is not necessarily the most complicated one.

It is the one where the problem, solution, and verification are all clear.

## What should not count as a meaningful contribution by itself?

Avoid choosing work solely because it involves:

- Changing button colors.
- Adjusting margins.
- Renaming variables.
- Reformatting files.
- Rewriting documentation.
- Adding a feature without understanding user demand.
- Refactoring working code without a clear engineering benefit.

These activities can be useful in the right context, but they should not be the primary contribution for this assignment.

---

# 17. Git and Branching Strategy

I should work on my own fork of the repository.

The original repository is:

[https://github.com/prooflinedev/session-recorder-chrome-extension](https://github.com/prooflinedev/session-recorder-chrome-extension)

My fork should be the destination for my development branch.

## 17.1 Check the Git remotes

```bash
git remote -v
```

Ideally:

- `origin` points to my fork.
- `upstream` points to Proofline's original repository.

If the fork is already configured, do not overwrite the remotes unnecessarily.

## 17.2 Create a feature branch

Use a descriptive branch name.

For example:

```bash
git checkout -b fix/recording-event-persistence
```

This is only an example. The actual branch name should reflect the confirmed contribution.

## 17.3 Review the working tree

```bash
git status
git diff
```

Make sure unrelated changes are not included.

## 17.4 Commit the change

Use a meaningful commit message.

Example:

```bash
git add .
git commit -m "fix: preserve recording events during session shutdown"
```

Only use a message like this if it accurately describes the actual implementation.

## 17.5 Push the branch

```bash
git push -u origin HEAD
```

Then open a pull request from my fork to the original Proofline repository.

---

# 18. Pull Request Expectations

The pull request should be easy for a maintainer to understand and verify.

Suggested structure:

## Title

A short description of the problem being solved.

## Problem

Explain what was happening and why it was undesirable.

## Root cause

Explain the underlying technical reason, with references to the relevant implementation.

## Solution

Explain what changed and why this approach was chosen.

## Testing

List:

- Unit tests.
- Type checks.
- Build results.
- End-to-end tests.
- Manual browser verification.

## Reproduction

Provide exact steps that another developer can follow.

## Results

Explain how the behavior changed after the fix.

## Limitations

Mention anything that remains incomplete or outside the scope.

A good PR should allow a maintainer to understand the change without having to guess what I intended.

---

# 19. Proofline Review of My Pull Request

After opening the PR, I need to use Proofline to review my contribution.

This is an important part of the application.

The purpose is not simply to show that an AI tool can produce code.

The purpose is to demonstrate that I can use AI review critically.

For each finding:

1. Read the full finding.
2. Locate the referenced code.
3. Check whether the issue is reproducible.
4. Determine whether the concern is valid.
5. Check the impact.
6. Decide whether to accept or reject the recommendation.
7. Explain the decision.

I should keep a record of:

- The review findings.
- Findings accepted.
- Changes made after review.
- Findings rejected.
- Reasons for rejection.
- Final verification results.

Do not blindly apply a suggested change if it conflicts with the actual implementation or product requirements.

---

# 20. Two-Minute Walkthrough

The final video should tell a concise engineering story.

Suggested structure:

### 0:00–0:20: Introduce the problem

Explain the issue and why it matters.

### 0:20–0:50: Demonstrate the original behavior

Show the reproduction steps and the incorrect result.

### 0:50–1:20: Explain the implementation

Show the important source changes and explain the solution.

### 1:20–1:45: Demonstrate the corrected behavior

Run the same reproduction steps and show the result.

### 1:45–2:00: Verification and conclusion

Mention the tests that passed and summarize the engineering improvement.

The video should be narrated, clear, and focused.

Avoid spending most of the recording explaining the entire product.

---

# 21. Final Application Checklist

## Repository contribution

- [ ] Fork the repository.
- [ ] Create a feature branch.
- [ ] Confirm the original problem.
- [ ] Inspect the implementation.
- [ ] Reproduce the problem.
- [ ] Implement a focused fix or feature.
- [ ] Add relevant tests.
- [ ] Run the required checks.
- [ ] Review the diff.
- [ ] Push the branch.
- [ ] Open a pull request.

## Proofline review

- [ ] Install Proofline on my GitHub organization.
- [ ] Configure the integration.
- [ ] Run a review of my contribution.
- [ ] Read all findings.
- [ ] Validate the findings.
- [ ] Accept useful recommendations.
- [ ] Explain rejected recommendations.
- [ ] Verify the final changes.

## Walkthrough

- [ ] Record a narrated video.
- [ ] Keep it within two minutes.
- [ ] Show the original problem.
- [ ] Show the code changes.
- [ ] Demonstrate the result.
- [ ] Explain verification.

## Application email

- [ ] Email `intern-applicants@proofline.sh`.
- [ ] Use subject `Software Engineering Intern`.
- [ ] Include a brief introduction.
- [ ] Include my location.
- [ ] Include my full-time availability for 3–6 months.
- [ ] Include the pull request URL.
- [ ] Include the video URL.

---

# 22. Important Repository References

Use these as the primary sources of truth.

| Resource                | Link                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session Recorder source | [https://github.com/prooflinedev/session-recorder-chrome-extension](https://github.com/prooflinedev/session-recorder-chrome-extension)                                                                 |
| Development guide       | [https://github.com/prooflinedev/session-recorder-chrome-extension/blob/main/DEVELOPMENT.md](https://github.com/prooflinedev/session-recorder-chrome-extension/blob/main/DEVELOPMENT.md)               |
| README                  | [https://github.com/prooflinedev/session-recorder-chrome-extension/blob/main/README.md](https://github.com/prooflinedev/session-recorder-chrome-extension/blob/main/README.md)                         |
| Documentation index     | [https://github.com/prooflinedev/session-recorder-chrome-extension/tree/main/docs](https://github.com/prooflinedev/session-recorder-chrome-extension/tree/main/docs)                                   |
| Sharing setup           | [https://github.com/prooflinedev/session-recorder-chrome-extension/blob/main/docs/sharing.md](https://github.com/prooflinedev/session-recorder-chrome-extension/blob/main/docs/sharing.md)             |
| Privacy policy          | [https://github.com/prooflinedev/session-recorder-chrome-extension/blob/main/docs/PRIVACY.md](https://github.com/prooflinedev/session-recorder-chrome-extension/blob/main/docs/PRIVACY.md)             |
| Report format           | [https://github.com/prooflinedev/session-recorder-chrome-extension/blob/main/docs/report-format.md](https://github.com/prooflinedev/session-recorder-chrome-extension/blob/main/docs/report-format.md) |
| GitHub issues           | [https://github.com/prooflinedev/session-recorder-chrome-extension/issues](https://github.com/prooflinedev/session-recorder-chrome-extension/issues)                                                   |
| GitHub pull requests    | [https://github.com/prooflinedev/session-recorder-chrome-extension/pulls](https://github.com/prooflinedev/session-recorder-chrome-extension/pulls)                                                     |
| Chrome Web Store        | [https://chromewebstore.google.com/detail/session-recorder/dboiheheijgmfpfhbmjggiijpgondghh](https://chromewebstore.google.com/detail/session-recorder/dboiheheijgmfpfhbmjggiijpgondghh)               |
| Proofline website       | [https://proofline.sh/](https://proofline.sh/)                                                                                                                                                         |

If a path or document has changed, inspect the current repository rather than relying on an outdated link.

---

# 23. Current Project Status and Immediate Objective

At the time this document was prepared:

**Repository selected:** Session Recorder Chrome extension.

**Repository cloned:** Yes.

**Dependencies installed:** Yes.

**Extension installed locally in Chrome:** Yes.

**Local functionality fully explored:** Not yet.

**Architecture fully understood:** Not yet.

**Confirmed bug identified:** No.

**Contribution selected:** No.

**Implementation started:** No.

**Pull request opened:** No.

**Proofline review completed:** No.

The immediate objective is to move from installation to understanding.

The next actions should be:

1. Verify the Node.js and pnpm versions.
2. Inspect `package.json` and the development guide.
3. Run `pnpm dev`.
4. Confirm the extension loads and works locally.
5. Explore the recording workflow.
6. Test annotations, reports, exports, and integrations.
7. Run the existing tests.
8. Understand the relevant source modules.
9. Identify a problem supported by evidence.

Do not jump to implementation before these steps are sufficiently complete.

---

# 24. Final Working Philosophy

This project should not be treated as a race to create the largest possible feature.

The goal is to demonstrate sound engineering judgment.

I want to show that I can enter an unfamiliar codebase, understand the product, investigate its behavior, discover a genuine engineering problem, and solve it without introducing unnecessary complexity.

I want to make a contribution that a maintainer can look at and say:

- The contributor understood the product.
- The problem is real.
- The investigation was thoughtful.
- The implementation follows the existing architecture.
- The tests are meaningful.
- The result is verifiable.
- The contributor understands the code they submitted.

I should be able to explain every important decision in my pull request.

I should be able to demonstrate the problem without relying on an AI-generated explanation.

I should be able to explain why my implementation solves the problem.

And I should be able to explain why I accepted or rejected each important AI review finding.

**The objective is not to make AI write a contribution for me. The objective is to use AI as an engineering partner while demonstrating that I can think, investigate, build, and verify like a software engineer.**

The guiding principle for the entire project is:

> Don't enter the repository looking for code to write. Enter it looking for a problem worth solving.

---

**End of project brief.**
