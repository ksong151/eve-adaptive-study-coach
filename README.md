# eve-adaptive-study-coach

A terminal [eve](https://eve.dev) agent that coaches you from a **public course website**. You give it a course page URL and a topic. It indexes the page's direct links, reads supported course material, asks a short-answer question grounded in what it read, gives cited feedback, recommends a specific course resource, and saves what to revisit for a later session.

It is a learning aid. It is not affiliated with any course, and nothing it generates is course-approved. It is told to follow each course's stated AI and collaboration policy and not to write solutions for graded work.

## Prerequisites

- Node.js with built-in TypeScript type stripping. `package.json` declares Node 24, the scaffold default. This project was developed and tested only on Node 26.8.1.
- A model connection for the agent. The default model is `openai/gpt-6-luna-fast` through Vercel AI Gateway (see `agent/agent.ts`). Either:
  - run `npx eve dev` and use `/login` (Vercel account, AI Gateway key, OpenAI key, Anthropic key, or ChatGPT subscription), or
  - set `AI_GATEWAY_API_KEY` in your shell or `.env.local` (git-ignored).

The importer, reader, tests, and `npm run inspect` need no model connection.

## Setup and commands

```bash
npm install
npm run typecheck      # tsc
npm test               # deterministic tests, mocked HTTP only
npm run build          # eve build
npx eve dev            # interactive terminal session with the coach
npm run eval           # eve behavior evals (needs a model connection)
npm run inspect -- https://cs144.github.io/                 # importer only, no model
npm run inspect -- <url> --scope <dirUrl> --read r12 --page 3
npm run reset-progress            # delete saved progress
npm run reset-progress -- --all   # also delete course indexes and cached course text
```

A session in `npx eve dev` looks like: *"My course is https://cs144.github.io/. Quiz me on how TCP sequence numbers work."*

## Architecture

```text
agent/
  agent.ts            model config; defaultTools: false
  instructions.md     study loop, citation and integrity rules
  channels/eve.ts     scaffold auth; local dev may use eval tool stubs
  sandbox.ts          scaffold just-bash sandbox (unused: no tool runs commands)
  tools/              the only tools the model can call
    import_course.ts    import one learner-supplied page
    list_resources.ts   list indexed resources and their status
    read_resource.ts    read an approved resource by id (no URL input)
    record_attempt.ts   save a question, answer, observation, and sources
    get_progress.ts     load saved progress and revisit list
  lib/
    scope.ts          URL policy (pure; runs before every request)
    fetcher.ts        bounded GET, manual redirect validation, guarded-fetch transport
    links.ts          link discovery and classification on one page
    extract.ts        HTML and PDF text extraction (PDF keeps page numbers)
    course.ts         import, read, search, budgets, caching
    progress.ts       observations and revisit list
    learner-input.ts  checks that a URL came from the learner's own message
    store.ts          local JSON storage under .study-coach/
evals/                eve behavior evals with stubbed tool results
test/                 node:test suites and an original toy-course fixture
scripts/              inspect-course.ts, reset-progress.ts
```

## Website boundary (enforced in code)

The model never receives a URL-fetching tool. `eve info --json` lists exactly five model-visible tools, and a test asserts this.

1. **Optional default tools are off.** `defaultTools: false` removes eve's `bash`, `read_file`, `write_file`, `web_fetch`, `web_search`, and `agent` tools.
2. **The start URL must come from the learner.** `import_course` rejects any `startUrl` or `additionalScopes` entry that does not appear in a user-role message. Page text arrives in tool results, so a URL in a page cannot pass. A broader prefix of what the learner typed also fails.
3. **One page, no crawling.** Import fetches only the start page and indexes its `<a href>` links. URLs in page text, scripts, stylesheets, and HTML comments are ignored.
4. **Scope.** The default scope is the start page's origin plus its directory. Each extra directory must be approved explicitly, must be https and public, and cannot be a site root. When many links fall outside scope, the import summary groups them by prefix so the learner can decide.
5. **Reading is by id.** `read_resource` accepts `courseId` and a resource id matching `r<digits>`. Its strict schema rejects extra fields such as `url`. Only resources with status `readable` are fetched. `external`, `outside_scope`, `unsupported_format`, and `blocked` links are listed with their original URL and are never requested.
6. **Every request and redirect hop is checked first.** `checkFetchAllowed` requires https, no credentials, the default port, a public dotted hostname, no private or loopback IP literal, and an in-scope path. Redirects are followed by hand, at most 3, and each `Location` is checked before it is requested.
7. **Network layer.** Requests are read-only GETs through Vercel's [`guarded-fetch`](https://github.com/vercel-labs/guarded-fetch), which resolves DNS, rejects private addresses, and pins the validated IP at connect time.
8. **Limits.** HTML responses are capped at 2 MB with a 15 s timeout. PDFs are capped at 15 MB with a 30 s timeout and 200 pages. Each import allows 250 links, 30 network reads, and 60 MB. Only `text/html`, `text/plain`, and `application/pdf` are accepted. Failures are recorded and not retried, except timeouts and network errors.
9. **Untrusted text.** Text returned to the model is labeled as untrusted course material. The boundary does not depend on the model obeying that label.
10. **Grounded citations.** `record_attempt` rejects sources whose text was never extracted, and PDF pages that have no extracted text.

## Supported formats

| Format | Handling |
| --- | --- |
| HTML (`text/html`, XHTML) | Text with block structure; scripts, styles, and nav removed |
| Plain text | As is |
| PDF with a text layer | Text per page, page numbers preserved |
| Scanned or image-only PDF pages | Reported as having no extractable text |
| Google Docs, video, Canvas, Gradescope, Ed, zip, notebooks, images | Listed as "content unavailable" with the original link |

## Progress storage and reset

Data lives in `.study-coach/` in the project root, which is git-ignored. Set `STUDY_COACH_DATA_DIR` to use a different directory.

- `courses/<courseId>.json` holds each course index and its approved scope.
- `content/<hash>.json` holds extracted text, cached so later sessions don't refetch.
- `progress.json` holds attempts. Each records the concept, question, your verbatim answer, an observation, feedback, cited sources with pages, and a recommended resource.

The observation is one of `demonstrated`, `partially_demonstrated`, `needs_review`, or `unclear`. It is the coach's note on one answer, not a validated mastery score. `get_progress` shows the latest observation per concept and the concepts to revisit.

To reset, run `npm run reset-progress` for progress only, or add `-- --all` to remove everything. Deleting `.study-coach/` does the same.

## Real example (importer only, captured 2026-10-18)

These runs used the real network path with no model. Course sites change, so your counts may differ.

`npm run inspect -- https://cs144.github.io/` made one request and reported:

```text
"approvedScope": "https://cs144.github.io/",
"resourceCounts": { "readable": 19, "external": 16 }
r23   readable  pdf   Checkpoint 0: networking warmup
r31   readable  pdf   TCP I (Slides)
r32   external  html  TCP I (Lecture notes)  [Google Docs/Drive/Forms: content unavailable (not fetched).]
r19   external  html  Gradescope  [Course platform that usually requires login: content unavailable (not fetched).]
```

Reading `r31` extracted 8 pages. Pages 5 and 6 have no text layer and are labeled as such. The page lists more checkpoints and handouts inside HTML comments, and those are correctly not indexed.

A second layout, `https://stanford-cs161.github.io/winter2026/lectures/`, keeps its slides in a sibling `assets/` directory. With the default scope, only the lectures page is readable:

```text
"resourceCounts": { "readable": 1, "outside_scope": 119, "external": 60, "blocked": 14 },
"outsideScopePrefixes": [
  { "prefix": "https://stanford-cs161.github.io/winter2026/assets/", "links": 60 },
  { "prefix": "https://stanford-cs161.github.io/winter2025-bank/", "links": 36 }, ...
```

After explicitly approving `--scope https://stanford-cs161.github.io/winter2026/assets/`, 52 resources became readable. Each shows its lecture heading, for example `Slides (PDF)` under `Lecture 2: Asymptotics, Worst-Case Analysis, and MergeSort › Lecture resources`. Reading it extracted an 82-page PDF. A resource in the unapproved `winter2025-bank/` directory was refused as `outside_scope` without a request.

## Tests and evals

- `npm test` runs deterministic suites over an original fixture course in `test/fixtures/`. They cover URL policy, mocked-HTTP boundary cases, link discovery, HTML and PDF extraction, import and read failure states, progress persistence, and tool input validation. The boundary cases are an external ad link, an off-site redirect, private and local URLs, and a model-supplied URL. Each asserts which requests the mock transport received, proving rejected URLs were never requested. Test PDFs are generated in code.
- `npm run eval` runs two eve evals against the real model with stubbed tool results. One covers the study flow, and the other checks that the coach doesn't claim to have read an ad link.

## Limitations

- Only HTML, plain text, and PDFs with a text layer are read. There is no OCR, and no Google Docs, slides, video, or login-only content.
- The importer reads one page. If a course splits materials across pages, import the materials page directly and approve its asset directory.
- Titles come from link text, the enclosing block, and nearby headings. Unusual layouts can still yield vague titles.
- Keyword search within a resource is plain substring matching.
- Resource ids are assigned in page order, so re-importing after a site change can renumber them. Saved attempts also store the title and URL.
- Single user, local files, no concurrency control.
- Question quality, feedback accuracy, and the observation label all depend on the model. They are not validated assessments.
- The `learner supplied this URL` check relies on the URL still being in the model's context. After compaction, the learner may need to paste it again.
- Link labels for well-known platforms such as Google Docs and Canvas are only labels. Every off-scope link is treated the same way regardless.

## License

MIT. See `LICENSE`. Course websites and their materials belong to their authors. This repository contains no course content. Fetched text is cached locally and never committed.
