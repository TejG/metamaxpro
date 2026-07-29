high-level system design:

`Cluely is basically a real-time context-aware AI copilot built around five layers: input capture, context assembly, orchestration, model inference, and response delivery.`

A strong interview-style answer:

- `Client layer`
  - Desktop app or browser extension
  - Captures user input, optional screen context, active app/window metadata, uploaded docs, and conversation history
  - Streams text/audio events to backend with low latency

- `Context ingestion layer`
  - Parses resume, job description, notes, and screenshots
  - Runs OCR if needed
  - Extracts structured entities like company, role, projects, metrics, interviewer intent
  - Stores searchable chunks in a vector store or hybrid retrieval index

- `Session and memory layer`
  - Maintains current conversation state
  - Keeps lightweight short-term memory for the live session
  - Optionally stores reusable user preferences and profile facts separately from transient context
  - Applies privacy controls and consent boundaries around what is retained

- `Orchestration layer`
  - Central reasoning engine that decides:
    - what context to include
    - whether to retrieve from resume or notes
    - whether screen context matters
    - which prompt template or mode to use, like interview mode or coding mode
  - Builds the final model input from:
    - system rules
    - user goal
    - retrieved context
    - recent conversation
    - output style constraints

- `Model layer`
  - Sends the assembled prompt to one or more LLM providers
  - Could use routing:
    - fast/cheap model for rewrites and retrieval planning
    - stronger model for final answer generation
  - Can support fallback providers for reliability

- `Post-processing layer`
  - Checks for hallucinations against grounded user data
  - Enforces style rules like concise, direct, no fabrication
  - Redacts unsafe or irrelevant details
  - Formats into spoken-answer form

- `Delivery layer`
  - Returns answer to overlay/chat UI
  - Optimized for low latency and incremental streaming
  - May provide short answer first, then expandable detail

If they want architecture flow, say:

```text
User Input / Screen / Files
        ↓
Capture + OCR + Parsing
        ↓
Context Store + Session Memory
        ↓
Retriever + Orchestrator
        ↓
Prompt Builder
        ↓
LLM Router / Inference
        ↓
Guardrails + Formatter
        ↓
Live Answer UI
```

If they ask about key design tradeoffs, say:

- `Latency vs quality`
  - More retrieval and multi-step orchestration improves quality but increases delay

- `Context breadth vs relevance`
  - Too much injected context hurts answer quality and cost
  - Need aggressive ranking and trimming

- `Persistence vs privacy`
  - Memory helps personalization, but user-controlled retention is critical

- `Single model vs multi-model routing`
  - Single model is simpler
  - Multi-model routing is cheaper and more resilient

If they ask for how you would build an MVP:

- Browser/desktop client for text + screenshot capture
- Backend API for session state
- OCR/parser pipeline
- Vector DB for resume/JD/notes
- Prompt orchestrator service
- LLM API with streaming responses
- Basic guardrails for grounding and style

Good one-line summary:

`Cluely works like a retrieval-augmented, session-aware copilot that continuously turns live user context into constrained, low-latency answers.`


Yes. Use this diagram:

```text
                   ┌──────────────────────────────┐
                   │        User / Interview      │
                   │  speaks, types, shares docs  │
                   └──────────────┬───────────────┘
                                  │
                                  ▼
                   ┌──────────────────────────────┐
                   │         Client Layer         │
                   │ desktop app / browser ext    │
                   │ - text input                 │
                   │ - audio input                │
                   │ - screenshot/screen capture  │
                   │ - file uploads               │
                   └──────────────┬───────────────┘
                                  │
                                  ▼
                   ┌──────────────────────────────┐
                   │      Ingestion Pipeline      │
                   │ - OCR on screenshots         │
                   │ - parse resume/JD/notes      │
                   │ - chunk documents            │
                   │ - extract entities/metadata  │
                   └──────────────┬───────────────┘
                                  │
                 ┌────────────────┴────────────────┐
                 ▼                                 ▼
    ┌───────────────────────────┐      ┌───────────────────────────┐
    │      Session Memory       │      │      Context Store        │
    │ - recent conversation     │      │ - vector DB / hybrid idx  │
    │ - active interview state  │      │ - resumes, JDs, notes     │
    │ - user preferences        │      │ - screenshots/OCR text    │
    └──────────────┬────────────┘      └──────────────┬────────────┘
                   │                                  │
                   └──────────────┬───────────────────┘
                                  ▼
                   ┌──────────────────────────────┐
                   │      Orchestration Layer     │
                   │ - decide what context matters│
                   │ - retrieve relevant chunks   │
                   │ - select mode/template       │
                   │ - build final prompt         │
                   └──────────────┬───────────────┘
                                  │
                                  ▼
                   ┌──────────────────────────────┐
                   │        LLM Router Layer      │
                   │ - fast model for planning    │
                   │ - strong model for answers   │
                   │ - fallback provider support  │
                   └──────────────┬───────────────┘
                                  │
                                  ▼
                   ┌──────────────────────────────┐
                   │   Guardrails / Postprocess   │
                   │ - grounding checks           │
                   │ - style enforcement          │
                   │ - no fabrication             │
                   │ - concise spoken formatting  │
                   └──────────────┬───────────────┘
                                  │
                                  ▼
                   ┌──────────────────────────────┐
                   │       Response Delivery      │
                   │ - overlay/chat UI            │
                   │ - streamed low-latency reply │
                   │ - short answer first         │
                   └──────────────────────────────┘
```

If they want a cleaner whiteboard version, draw this:

```text
[User]
   ↓
[Client: text/audio/screen/files]
   ↓
[OCR + Parsing + Chunking]
   ↓
[Memory] + [Vector Store]
   ↓
[Retriever + Orchestrator]
   ↓
[Prompt Builder]
   ↓
[LLM Router]
   ↓
[Guardrails]
   ↓
[Live Response UI]
```

If you need to explain each block in one line:

- `Client`: captures live inputs
- `Ingestion`: converts raw inputs into structured searchable context
- `Memory`: keeps session state
- `Context store`: stores long-form grounding data
- `Orchestrator`: decides what to send to the model
- `LLM router`: picks the right model/provider
- `Guardrails`: enforces quality and safety
- `Delivery`: returns fast, readable answers

If they ask for a production-level version, add:

```text
                    ┌─────────────── Observability ───────────────┐
                    │ logs, traces, latency, quality monitoring   │
                    └──────────────────────────────────────────────┘

                    ┌──────────────── Security / Privacy ──────────┐
                    │ consent, encryption, retention controls      │
                    └──────────────────────────────────────────────┘
```

Best one-line summary:

`It is a retrieval-augmented, session-aware, low-latency copilot pipeline wrapped around live user context.`

RAG as a multi-source hybrid retrieval pipeline optimized for low latency and high relevance.`

Then break it down:

- `1. Ingest sources`
  - resume
  - job description
  - notes
  - prior chat history
  - OCR text from screenshots or visible tabs

- `2. Parse and chunk`
  - clean the text
  - split into semantically meaningful chunks, not just fixed token windows
  - attach metadata like `source_type`, `company`, `role`, `timestamp`, `session_id`

- `3. Index in two ways`
  - embeddings in a vector DB for semantic search
  - keyword or BM25 index for exact matches like company names, tools, metrics, project titles

- `4. Retrieve with hybrid search`
  - for each user query, run both vector and keyword retrieval
  - merge results
  - apply metadata filters, like only current interview docs or current session context

- `5. Re-rank`
  - use a lightweight reranker or cross-encoder
  - rank chunks by relevance to the live question, not just similarity

- `6. Context assembly`
  - take top `k` chunks
  - deduplicate
  - trim for token budget
  - group by source priority, for example resume and current JD above stale chat history

- `7. Prompt grounding`
  - inject retrieved chunks into the final prompt as evidence
  - instruct the model to answer only from grounded context when facts are user-specific

- `8. Feedback loop`
  - log retrieval quality
  - track misses
  - tune chunk size, top `k`, reranking, and metadata filters over time

Use this architecture line:

```text
Docs + OCR + Chat History
        ↓
 Parse / Chunk / Tag Metadata
        ↓
Vector Index + BM25 Index
        ↓
 Hybrid Retriever
        ↓
   Re-ranker
        ↓
 Context Builder
        ↓
      LLM
```

If they ask why hybrid RAG:

`Because semantic search finds meaningfully related content, while keyword search catches exact high-signal terms like company names, tech stacks, project names, and metrics. In interview context, you usually need both.`

If they ask how session-aware RAG works:

`I’d separate long-lived profile knowledge from short-term conversational memory. Then I’d bias retrieval toward current-session content first, while still allowing fallbacks to persistent sources like the resume or prep notes.`

Strong concise closer:

`So the implementation is basically multi-source ingestion, semantic plus keyword indexing, metadata-aware retrieval, reranking, and prompt grounding tuned for fast live answers.`


Yes. Here’s a more detailed but still interview-friendly version you can say out loud:

`RAG would likely be implemented as a hybrid, multi-source retrieval system. The main idea is that instead of sending the entire resume, job description, notes, and conversation history into the prompt every time, the system first retrieves only the most relevant pieces of information for the current question, then uses those as grounded context for the LLM.`

A clearer step-by-step explanation:

- `First, ingest all relevant sources`
  - This includes the user’s resume, job description, prep notes, prior conversation, and possibly OCR text extracted from the current screen or screenshots.
  - Each of these sources has a different role. For example, the resume is the source of truth for experience, the job description tells us what the interviewer cares about, and chat history helps preserve continuity.

- `Second, clean and chunk the data`
  - Raw documents are usually too large to retrieve efficiently, so they get split into chunks.
  - Good chunking is important. You usually don’t want arbitrary fixed splits only. You want chunks that preserve semantic meaning, like one project, one achievement, one job responsibility, or one interview note.
  - Each chunk gets metadata such as source type, company, role, timestamp, and session ID.

- `Third, create two retrieval indexes`
  - One is a `vector index`, where each chunk is embedded into a semantic space so the system can find meaningfully related content.
  - The other is a `keyword index`, often BM25 or something similar, which helps catch exact matches.
  - This is important because interview questions often depend on exact terms like company names, project names, tools, metrics, or frameworks.

- `Fourth, use hybrid retrieval at query time`
  - When the user asks a question, the orchestrator does not rely on one retrieval strategy.
  - It runs both semantic retrieval and keyword retrieval.
  - Then it merges those results into a candidate set.
  - This gives a better balance between conceptual similarity and exact lexical matching.

- `Fifth, apply metadata filtering`
  - Not all chunks should compete equally.
  - If the user is interviewing for Meta, chunks related to Meta prep notes or that particular JD should be prioritized over unrelated old notes.
  - If the question is about past experience, resume chunks may be ranked above temporary screen context.
  - Metadata filtering helps reduce noise and improves latency.

- `Sixth, re-rank the retrieved chunks`
  - Initial retrieval is often broad.
  - A re-ranker, often a lightweight cross-encoder or learned ranking model, scores the candidate chunks against the actual user question.
  - This helps ensure the final retrieved evidence is not just similar, but truly useful for answering the question.

- `Seventh, assemble the final context`
  - The top chunks are deduplicated, trimmed, and ordered before being placed into the prompt.
  - Usually there is a token budget, so the system has to be selective.
  - It might prioritize:
    - current session context first
    - then resume facts
    - then job description alignment
    - then prep notes
  - The goal is to include enough context to ground the answer without overwhelming the model.

- `Eighth, prompt the model with grounded evidence`
  - The final prompt typically contains:
    - system instructions
    - the live user question
    - retrieved context snippets
    - output constraints like concise, direct, interview-ready, and no fabrication
  - This is where RAG becomes valuable, because the model is not guessing from generic world knowledge. It is answering using retrieved evidence tied to the user.

- `Ninth, enforce post-processing and guardrails`
  - After generation, the system may check whether the answer is grounded in retrieved user-specific context.
  - It may also enforce style requirements, such as spoken brevity, confidence, and avoiding invented details.
  - For an interview copilot, this is especially important because fabricated numbers or projects would be risky.

- `Finally, use a feedback loop`
  - In production, retrieval performance is tuned continuously.
  - Teams usually monitor:
    - whether the right chunks were retrieved
    - whether the answer used them correctly
    - latency
    - token cost
    - failure cases
  - Then they adjust chunk size, retrieval depth, ranking logic, and metadata weighting.

A good architecture summary:

```text
Resume / JD / Notes / OCR / Chat History
                ↓
        Parse + Clean + Chunk
                ↓
   Embeddings Index + BM25 Index
                ↓
        Hybrid Retrieval Layer
                ↓
             Re-ranker
                ↓
          Context Builder
                ↓
         Prompt to the LLM
                ↓
   Guardrails + Spoken Formatting
                ↓
          Final User Response
```

If they ask `why not just put everything in the prompt`,

`Because it would be too expensive, slower, and less relevant. A lot of the context would be noise. RAG lets the system select only the evidence needed for the current question, which improves both latency and answer quality.`

If they ask `why hybrid instead of only vector search`, 

`Pure vector retrieval is good for semantic meaning, but it can miss exact high-signal terms. In interview use cases, exact matches like project names, company names, and tools matter a lot, so hybrid retrieval gives better precision.`

If they ask `how session-aware RAG works`, 

`I’d separate persistent knowledge from temporary session memory. Persistent knowledge would include the resume and reusable notes. Session memory would include the current interview flow, recent questions, and active screen context. Retrieval would be biased toward current-session relevance while still allowing fallbacks to long-term user context.`

Best polished closer:

`So overall, RAG here is not just a vector database. It’s really a full retrieval pipeline: multi-source ingestion, semantic and lexical indexing, metadata-aware filtering, reranking, context assembly, and prompt grounding, all optimized for low-latency, high-precision answers.`

Use this structure:

`There are four main levers to reduce cost in this kind of application: reduce tokens, reduce model usage, reduce retrieval overhead, and reduce unnecessary turns.`

Strong interview answer:

- `1. Reduce prompt size`
  - Don’t send full resume, JD, notes, and history every turn
  - Use RAG to retrieve only top relevant chunks
  - Summarize older conversation instead of replaying raw history
  - Deduplicate overlapping context before prompt assembly
  - Set strict token budgets per source

- `2. Use model routing`
  - Small/cheap model for query rewriting, classification, and retrieval planning
  - Larger model only for the final user-facing answer
  - Route simple questions to a cheaper model entirely
  - Use fallback to premium models only when confidence is low

- `3. Optimize retrieval`
  - Pre-embed documents once at ingestion time
  - Cache retrieval results for repeated or similar queries
  - Keep `top-k` small
  - Only rerank when initial retrieval confidence is weak
  - Use metadata filters to shrink search space before retrieval

- `4. Compress memory`
  - Store conversation summaries instead of full transcripts
  - Separate long-term profile data from short-term session memory
  - Retain only high-signal facts and recent turns
  - Expire stale context aggressively

- `5. Avoid unnecessary LLM calls`
  - Combine steps where possible
  - Don’t call one model for rewrite, another for planning, another for answer unless it actually improves quality
  - Use deterministic logic for simple orchestration instead of LLM-based orchestration everywhere

- `6. Cache aggressively`
  - Cache embeddings
  - Cache parsed OCR output
  - Cache frequent prompt templates
  - Cache answers or intermediate retrieval for repeated interview questions like `tell me about yourself` or `why this role`

- `7. Control output length`
  - Keep answers short by default
  - Stream a short answer first
  - Expand only if the user asks
  - Output length directly affects token cost

- `8. Use cheaper preprocessing`
  - OCR and entity extraction can often use non-LLM pipelines or smaller local models
  - Don’t use a large LLM for tasks that can be done with rules or lightweight models

- `9. Tune chunking carefully`
  - Bad chunking increases retrieval noise and causes larger prompts
  - Good chunking reduces both retrieval cost and final token usage

- `10. Add confidence-based gating`
  - If the system already has enough high-confidence context, skip additional retrieval or reranking
  - Escalate to deeper pipelines only for ambiguous or high-stakes questions

A clean way to say it:

`The biggest practical savings usually come from sending less context, routing easy tasks to cheaper models, summarizing memory, and avoiding multi-step LLM pipelines unless they clearly improve answer quality.`

If they ask for a concise product-systems framing:

```text
Cost optimization = 
prompt compression
+ model routing
+ caching
+ selective retrieval
+ fewer LLM calls
```

Best polished closer:

`So I’d treat cost reduction as a pipeline optimization problem, not just a model pricing problem. The goal is to reserve expensive inference only for the small fraction of turns that really need it.`


Use this:

```js
export const systemPrompt = `
You are the user's live assistant.

Respond tersely, directly, and in natural spoken English.
Do not add filler, preamble, or meta-commentary.
Do not end with a question.

Primary job:
- Help the user perform well in interviews across behavioral, technical, product, role-fit, and follow-up questions.
- Tailor answers to the user's background, resume, notes, and the job description when provided.
- Never fabricate experience, credentials, companies, metrics, or project details.
- If context is missing, provide a tight answer structure the user can fill in quickly.

Behavioral answers:
- Use STAR: situation, task, action, result.
- Pick examples that show ownership, prioritization, collaboration, ambiguity, impact, and learning.
- Keep answers concise enough to say out loud.

Technical answers:
- Start with the direct answer.
- Explain clearly at interview depth.
- State tradeoffs, constraints, and why one approach is better than another.
- If needed, think aloud briefly, make a reasonable assumption, and move toward a useful answer.

Role-fit and product answers:
- Infer what the interviewer is evaluating.
- Answer confidently, clearly, and specifically.
- Sound polished, not robotic or arrogant.

Recovery behavior:
- If the user seems stuck, help them recover with:
  - a crisp answer they can say now
  - a structured fallback version
  - optional bullets with deeper detail if time allows

Formatting:
- Prefer short paragraphs or bullets.
- Use markdown cleanly.
- No headers unless explicitly requested.
- Use code blocks only for actual code.

Style:
- Concise
- Sharp
- Practical
- Spoken, not essay-like
`;
```

if needed to mimic the response style more closely, use this stricter version:

```js
export const systemPrompt = `
You are a real-time interview copilot.

Rules:
- Be concise.
- Be direct.
- No filler.
- No preamble.
- No meta-comments.
- Do not end with a question.
- Write in clean spoken English.

What you do:
- Turn the user's context into interview-ready answers.
- Help with behavioral, technical, product, and role-fit questions.
- Optimize for answers the user can say out loud immediately.

Grounding:
- Use the user's actual resume, job description, notes, and provided context as ground truth.
- Do not invent facts, employers, achievements, or numbers.
- If missing context, give a fill-in-the-blank structure instead of guessing.

Behavioral mode:
- Use STAR.
- Emphasize ownership, decision-making, collaboration, and measurable impact.
- Keep it crisp.

Technical mode:
- Answer first.
- Then explain.
- Include tradeoffs.
- Keep depth appropriate for an interview.

If the question is vague:
- Infer the evaluation signal.
- Answer that signal directly.

If the user is stuck:
- Provide a safe, strong response they can say immediately.
- Then provide a slightly stronger version if they have time.

Output style:
- Short paragraphs or bullets.
- No unnecessary formatting.
- Sound confident, polished, and natural.
`;
```

If they want `prompt.js` plus a sample API call:

```js
export const systemPrompt = `You are a real-time interview copilot...
`;
```

```js
import OpenAI from "openai";
import { systemPrompt } from "./prompt.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const response = await client.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: "Tell me about yourself for a PM interview." }
  ],
  temperature: 0.4
});

console.log(response.choices[0].message.content);
```

Important caveat you can say if needed:

`You can mimic the style with a system prompt, but you cannot fully replicate behavior unless you also replicate the surrounding context pipeline, memory, screen/input handling, grounding, and response rules.`