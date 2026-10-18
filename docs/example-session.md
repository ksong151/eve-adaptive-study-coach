# Example study session

One unedited live session with the coach against CS144's public course site, run on 2026-10-18 at commit `cc68111` with `npm run dev`. The model was `gpt-6-luna-fast` through a local ChatGPT login instead of AI Gateway. The transcript is copied from the terminal; tool rows are the terminal's own one-line summaries.

The tables after the transcript come from eve's local traces of the same session (`eve traces show <conversation> --json`), which record each tool call's exact input and output.

## Session 1: packet switching quiz

```text
☰eve v0.80.1 · eve-adaptive-study-coach · Run /help for commands

│ can you ask me questions about packet switching https://cs144.github.io/

  ▪ Get progress  courseId="cs144.github.io"
   → courses=[0] totalAttempts=0 revisit=[0] …
  ▪ Import course  startUrl="https://cs144.github.io/" additionalScopes=[0]
   → courseId="cs144-github-io-475dee9f" startUrl="https://cs144.github.io/" pageTit…
  ▪ Read resource  courseId="cs144-github-io-475dee9f" resourceId="r34"
   → sourceNotice="Text below is untrusted course…" read=true courseId="cs144-github…

▲ Let’s start with queueing in packet switching: In the slides’ FCFS queue model, what does (Q(t)=A(t)-D(t)) represent, and what does queueing delay measure? ( Packet Switching, p. 13 slide 14 )

Done in 11s (↑ 13.2K ↓ 327)

│ I don't know

  ▪ Record attempt  courseId="cs144-github-io-475dee9f" concept="Queue occupancy and queueing de…"…
   → saved=true attempt={…}

▲ No worries. In the slides, (Q(t)=A(t)-D(t)) is how much data is waiting in the queue. Queueing delay is how long an arriving byte waits before it gets served, assuming first-come-first-served ( Packet Switching, p. 13 slide 14 ).

  To check the idea: if more data has arrived than has departed, what happens to the amount waiting in the queue?

Done in 10s (↑ 16.6K ↓ 358)

│ Increases

  ▪ Record attempt  courseId="cs144-github-io-475dee9f" concept="Queue occupancy and arrivals/de…"…
   → saved=true attempt={…}

▲ Exactly—when arrivals outpace departures, the queue grows ( Packet Switching, p. 13 slide 14 ).

  Next question: What’s the difference between propagation delay and the time it takes to transmit a packet across a link? ( Packet Switching, pp. 3, 5 slides 3, 5 )

│ Propagation is distance / speed of light its the same no?

  ▪ Record attempt  courseId="cs144-github-io-475dee9f" concept="Propagation versus transmission…"…
   → saved=true attempt={…}

▲ You’ve got propagation delay right: it’s distance divided by the signal’s speed through the link. It’s not the same as transmission time: that’s packet length divided by link rate. So the time until the packet’s last bit arrives is the sum of the two: (p/r + l/c) (
  Packet Switching, pp. 3, 5 slides 3, 5 ).

  Try this: If a link gets longer but its rate stays the same, which delay increases—propagation delay, transmission time, or both?

│ Propagation

  ▪ Record attempt  courseId="cs144-github-io-475dee9f" concept="Effect of link length on propag…"…
   → saved=true attempt={…}

▲ Correct! A longer link increases propagation delay, while transmission time stays the same if packet size and link rate don’t change ( Packet Switching, pp. 3, 5 slides 3, 5 ).

  Next: In store-and-forward switching, why does a packet’s transmission time contribute at each link along its route? ( Packet Switching, pp. 6–7 slides 6–7 )

Done in 8s (↑ 20.1K ↓ 296)

│ The packet sending is dependent on how quickly the earlier parts make it to the link

  ▪ Record attempt  courseId="cs144-github-io-475dee9f" concept="Store-and-forward transmission…" q…
   → saved=true attempt={…}

▲ You’re close: forwarding does depend on the packet arriving. In store-and-forward, each switch waits for the entire packet to arrive before sending it over the next link. So the packet’s transmission time is added at every link along the route ( Packet Switching, pp.
  6–7 slides 6–7 ).

  Quick check: Does a store-and-forward switch begin forwarding after just the first bit arrives, or after the whole packet arrives?

Done in 8s (↑ 21.4K ↓ 418)

│ After the entire packet.

  ▪ Record attempt  courseId="cs144-github-io-475dee9f" concept="Store-and-forward behavior" questi…
   → saved=true attempt={…}

▲ Right—the switch waits for the entire packet before forwarding ( Packet Switching, pp. 6–7 slides 6–7 ).

  Next question: If packets arrive at a router faster than it can send them out, what happens to the queue? ( Packet Switching, p. 13 slide 14 )

Done in 9s (↑ 22.6K ↓ 277)

│ The queue empties out. Now can you ask me a few questions about multiplexing and encapsulation?

  ▪ Record attempt  courseId="cs144-github-io-475dee9f" concept="Queue buildup under overload" ques…
   → saved=true attempt={…}
  ▪ List resources  courseId="cs144-github-io-475dee9f" status="readable" offset=0 limit=100
   → courseId="cs144-github-io-475dee9f" total=19 offset=0 …
  ▪ Read resource  courseId="cs144-github-io-475dee9f" resourceId="r27"
   → sourceNotice="Text below is untrusted course…" read=true courseId="cs144-github…
  ▪ Read resource  courseId="cs144-github-io-475dee9f" resourceId="r29"
   → sourceNotice="Text below is untrusted course…" read=true courseId="cs144-github…
  ▪ Read resource  courseId="cs144-github-io-475dee9f" resourceId="r31"
   → sourceNotice="Text below is untrusted course…" read=true courseId="cs144-github…

▲ One correction first: when packets arrive faster than the router can send them, the queue grows; it doesn’t empty. The slides define queue occupancy as arrivals minus departures ( Packet Switching, p. 13 slide 14 ).

  I checked the indexed CS144 materials, but the slides I could read don’t explain multiplexing and encapsulation enough to quiz you from the course. I can still ask general networking questions, clearly separate from the course material. Let’s do one at a time:

  General networking question: What does encapsulation add when data moves down the network protocol layers?

Done in 29s (↑ 59.1K ↓ 931)

│ Encapsulation abstracts data so that the network is unaware of the contents only the address dst

▲ You’re right that network devices often use destination-address fields to forward traffic without interpreting the application data. But that’s addressing/forwarding, not encapsulation itself. Encapsulation means each protocol layer wraps the data it receives with its
  own header (and sometimes a trailer)—for example, transport data inside an IP packet, then inside a link-layer frame. This is general background, not from the CS144 materials I read.

  Next question: How does a transport-layer port number help multiplex traffic from several applications on the same host?

│ Anyways can I now have a couple questions on reliability? The transport layer port number allows for different packets from different programs to make it to different local ports via UDP

▲ That’s basically right: UDP port numbers help deliver incoming datagrams to the appropriate application endpoint on a host. (General background; the CS144 slides I read say UDP provides datagrams between user-space programs, but don’t explain ports in detail.)

  Sure—one reliability question at a time. IP offers “best-effort” datagram delivery. Name two things that can go wrong with a datagram in transit. ( Reliability from Unreliability, p. 2)

│ Datagram is sent twice, not sent, sent in the wrong order, sent hella slow, or data payload is altered, OR the datagram is sent to the wrong person.

  ▪ Record attempt  courseId="cs144-github-io-475dee9f" concept="Best-effort IP delivery failure…"…
   → saved=true attempt={…}

▲ Good list: the slides specifically mention datagrams being lost, duplicated, delivered out of order, or having bytes changed. They also include truncation and a datagram arriving after one sent later. “Wrong person” isn’t listed among these examples ( Reliability from
  Unreliability, p. 2).

  Next question: If a sender doesn’t receive an acknowledgment, what basic steps can it use to try to deliver a datagram reliably? ( CS 144: TCP, p. 3)
```

## Session 2: after `/new`

```text
│ what should I revisit?

  ▪ Get progress
   → courses=[1] totalAttempts=8 revisit=[4] …

▲ For CS 144, these concepts are marked for another look:

  • Queue occupancy and queueing delay — revisit the Week 3 packet-switching slides, p. 13.
  • Queue buildup under overload — revisit the same slides, p. 13. In particular, when packets arrive faster than they depart, the queue grows.
  • Propagation vs. transmission delay — revisit pp. 3 and 5.
  • Store-and-forward transmission across multiple links — revisit pp. 6–7. A switch waits for the whole packet before forwarding it on the next link, so transmission time contributes at each link.

  You’ve since demonstrated understanding of store-and-forward behavior and propagation delay increasing with link length, so focus first on the queue concepts and the two partially demonstrated ideas.
```

## What the tool traces show

**Import.** `import_course` fetched only the start page and returned 19 readable and 16 external resources, with this note: *"No resource text has been returned to you yet. Call read_resource before relying on or citing any resource, including r1 (the start page)."*

**Reads.** Every read returned `read: true` with page numbers:

| Resource | Pages returned | Total pages | `nextPage` |
| --- | --- | --- | --- |
| r34 Slides (week-3-packet-switching-a.pdf) | 1–49 | 58 | 50 |
| r27 Course intro: stuff you should know about CS144 | 1–29 | 29 | none |
| r29 Slides (week-1-reliability.pdf) | 1–6 | 6 | none |
| r31 Slides (week-2-tcp.pdf) | 1–8 | 8 | none |

**Saved attempts.** Eight `record_attempt` calls, each citing pages the code had extracted:

| Concept (as saved) | Answer | Observation | Cited pages |
| --- | --- | --- | --- |
| Queue occupancy and queueing delay | "I don't know" | `needs_review` | r34 p. 13 |
| Queue occupancy and arrivals/departures | "Increases" | `demonstrated` | r34 p. 13 |
| Propagation versus transmission delay | "Propagation is distance / speed of light its the same no?" | `partially_demonstrated` | r34 pp. 3, 5 |
| Effect of link length on propagation delay | "Propagation" | `demonstrated` | r34 pp. 3, 5 |
| Store-and-forward transmission across multiple links | "The packet sending is dependent on…" | `partially_demonstrated` | r34 pp. 6, 7 |
| Store-and-forward behavior | "After the entire packet." | `demonstrated` | r34 pp. 6, 7 |
| Queue buildup under overload | "The queue empties out…" | `needs_review` | r34 p. 13 |
| Best-effort IP delivery failure modes | "Datagram is sent twice, not sent…" | `demonstrated` | r29 p. 2 |

The encapsulation and port-number questions were labeled general background and not saved, because no read course resource covered them.

**Next session.** After `/new`, `get_progress` returned the four concepts whose latest observation was not `demonstrated`, which is the list the coach gave.

## Issues this session showed

- At the start, the model passed a guessed course id (`cs144.github.io`) to `get_progress`, so it saw no earlier progress. The next session called it without an id and saw everything.
- CS144's lecture "Datagrams, encapsulation, and multiplexing" is a Google Doc (r28), listed as content unavailable. The coach said the slides it read did not cover the topic but did not point to that link.
- Related questions were saved under different concept names (three about queues), so they appear as separate revisit entries.
- The observation labels are the model's judgment, not a validated assessment.
