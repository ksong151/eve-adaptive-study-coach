# eve-adaptive-study-coach

A terminal [eve](https://eve.dev) agent that coaches you from a **public course website**. You give it a course page URL and a topic. It indexes the page's direct links, reads supported material, asks a short-answer question grounded in what it read, gives cited feedback, recommends a course resource, and saves what to revisit next session.

It is a learning aid, not affiliated with any course. It is told to follow each course's stated AI and collaboration policy and not to write solutions for graded work.

## Prerequisites

- Node.js with built-in TypeScript type stripping. `package.json` declares Node 24, the scaffold default; this project was tested only on Node 26.8.1.
- A model connection: run `npx eve dev` and use `/login`, or set `AI_GATEWAY_API_KEY` in `.env.local` (git-ignored). The default model is `openai/gpt-6-luna-fast` through Vercel AI Gateway (`agent/agent.ts`).

Tests, the importer, and `npm run inspect` need no model connection.

## Commands

```bash
npm install
npm run typecheck
npm test                 # deterministic tests, mocked HTTP only
npm run build
npx eve dev              # chat with the coach
npm run eval             # eve behavior evals; needs a model connection
npm run inspect -- <courseUrl> [--scope <dirUrl>] [--read r12] [--page 3]   # importer only, no model
npm run reset-progress
```

Example prompt in `npx eve dev`: *"My course is https://cs144.github.io/. Quiz me on how TCP sequence numbers work."*

## Architecture

- `agent/tools/`: the only tools the model can call: `import_course`, `list_resources`, `read_resource`, `record_attempt`, `get_progress`.
- `agent/lib/`: URL policy (`scope.ts`), bounded fetcher (`fetcher.ts`), link discovery (`links.ts`), HTML/PDF extraction (`extract.ts`), import and read (`course.ts`), progress (`progress.ts`), learner-URL check (`learner-input.ts`), local storage (`store.ts`).
- `agent/instructions.md`: study loop, citation, and academic-integrity rules.
- `test/`, `evals/`, `scripts/`: tests with an original fixture course, eve evals with stubbed tools, and the inspect/reset scripts.

## Source restrictions (enforced in code)

1. **No general tools.** `defaultTools: false` removes eve's shell, file, web fetch, web search, and agent tools. A test asserts that `eve info` lists only the five course tools.
2. **Learner-supplied start page.** `import_course` rejects a URL or extra scope that does not appear in the learner's own messages. Page text arrives in tool results, so it cannot supply URLs.
3. **One page, no crawling.** Import fetches only the start page and indexes its `<a href>` links. URLs in page text and HTML comments are ignored.
4. **Narrow scope.** Default scope is the start page's directory on its origin. Extra directories must be approved explicitly, be public https, and not be a site root. The import summary groups out-of-scope same-site links by directory so the learner can decide.
5. **Read by id only.** `read_resource` takes a resource id like `r31`, never a URL. External, out-of-scope, blocked, and unsupported links are listed with their original URL and never requested.
6. **Every request and redirect hop is checked before it is sent:** https, default port, no credentials, public hostname, no private IP literal, in scope, at most 3 redirects. Requests are read-only GETs through Vercel's [`guarded-fetch`](https://github.com/vercel-labs/guarded-fetch), which also checks DNS and pins the connected IP.
7. **Limits.** HTML 2 MB / 15 s; PDF 15 MB / 30 s / 200 pages; per import 250 links, 30 network reads, 60 MB; content types `text/html` and `application/pdf` only.
8. **Grounded citations.** Fetched text is labeled untrusted course material. `record_attempt` rejects sources that were never extracted and PDF pages with no extracted text.

## Supported formats

| Format | Handling |
| --- | --- |
| HTML | Text with block structure; scripts, styles, and nav removed |
| PDF with a text layer | Text per page, page numbers kept |
| Image-only PDF pages | Labeled as having no extractable text |
| Google Docs, video, Canvas, Gradescope, Ed, zip, notebooks, images, plain text | Listed as "content unavailable" with the original link |

## Progress storage and reset

Everything is stored in `.study-coach/` in the project root (git-ignored; override with `STUDY_COACH_DATA_DIR`): course indexes, extracted text cached for later sessions, and `progress.json`. Each attempt records the concept, question, your verbatim answer, an observation, feedback, cited sources with pages, and a recommended resource.

Observations are `demonstrated`, `partially_demonstrated`, `needs_review`, or `unclear`. They are the coach's notes on one answer, not a validated mastery score.

`npm run reset-progress` deletes `progress.json`. Delete `.study-coach/` to also remove course indexes and cached text.

## Real example (importer only, captured 2026-10-18)

Real network runs with no model; course sites change, so results may differ.

`npm run inspect -- https://cs144.github.io/ --read r31` made one request for the page, found 19 readable and 16 external links, and read 8 pages from the TCP slides:

```text
r23   readable  pdf   Checkpoint 0: networking warmup
r31   readable  pdf   Slides (week-2-tcp.pdf)
r32   external  html  Lecture notes (view)  [Google Docs/Drive/Forms: content unavailable (not fetched).]
READ r31 "Slides (week-2-tcp.pdf)" (8 pages)
```

`https://stanford-cs161.github.io/winter2026/lectures/` keeps slides in a sibling `assets/` directory. With the default scope only the lectures page is readable, and the summary points to `https://stanford-cs161.github.io/winter2026/assets/` (60 links). With `--scope` set to that directory, 52 resources become readable, such as `PDF (Lecture2.pdf)` under `Lecture 2: Asymptotics, Worst-Case Analysis, and MergeSort`, an 82-page PDF. Links in the unapproved `winter2025-bank/` directory stay unfetched.

## Limitations

- No OCR, plain text, Google Docs, video, or login-only content.
- One page per import. For courses that split materials across pages, import the materials page and approve its asset directory.
- Generic link text ("PDF", "Slides") gets the file name added, which is uninformative for some URLs, such as Google Docs ending in `view`.
- Resource ids follow page order, so re-importing a changed site can renumber them; saved attempts also keep title and URL.
- Single user, local files.
- Question and feedback quality and the observation label depend on the model and are not validated assessments.
- The learner-URL check needs the URL in the model's context; after compaction the learner may need to paste it again.

## License

MIT (`LICENSE`). The repository contains no course content; fetched text is cached locally and never committed.
