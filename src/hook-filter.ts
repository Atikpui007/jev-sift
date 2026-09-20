/**
 * Claude Code PostToolUse hook: filter a search tool's result through Jev
 * before the model sees it.
 *
 * The tool result is JSON, and Jev's state is JSON, so the result goes to
 * Jev as-is. The candidates are whatever collection the result naturally
 * carries: an array of matches, files, search hits, or MCP content items.
 * Each candidate gets one boolean question referencing it by path in the
 * state. Candidates that fail are removed from the collection; everything
 * else about the result, including its shape and the order of survivors,
 * is untouched.
 *
 * Text-only results (Bash stdout) are the degenerate case: the text is
 * turned into an array of blocks so it can be judged the same way, then
 * joined back.
 *
 * Fails open: on any error the hook prints nothing and the original result
 * is delivered. Every run is logged to .claude/hook-logs/sift.jsonl.
 *
 * Environment:
 *   JEV_FILTER_DISABLED=1      passthrough without calling Jev
 *   JEV_FILTER_THRESHOLD       keep candidates with noul >= this (default 0.5)
 *   JEV_FILTER_BATCH           candidates per Jev request (default 100)
 *   JEV_FILTER_INSTRUCTION     override the per-candidate question; {path}
 *                              is replaced with the candidate's state path
 *   JEV_FILTER_NOTE=1          also attach a one-line additionalContext summary
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { evaluateWithJev } from './jev.js';

// __dirname exists in the CommonJS bundle; import.meta.url in the TypeScript source run by tsx.
const here = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
config({ path: join(here, '..', '.env.local'), quiet: true }); // local dev only
// Plugin install: the key entered at enable time arrives as CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY.
if (!process.env.TYPESAFE_API_KEY && process.env.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY) {
  process.env.TYPESAFE_API_KEY = process.env.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY;
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type HookInput = {
  tool_name: string;
  tool_input: Record<string, Json>;
  tool_response: Json;
  transcript_path?: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
};

/**
 * One Choice per candidate. Written for a literal reader: the question names
 * the state fields to use, and each option says what it covers, what it does
 * not cover, and boundary cases. The options are mutually exclusive, so the
 * probabilities compete. A candidate is hidden only when Jev puts at least
 * DROP_THRESHOLD on `hide`.
 * {path} is replaced with the candidate's state path.
 */
type CandidateKind = 'file_path' | 'matched_line' | 'directory_entry' | 'search_hit' | 'whole_file' | 'item';

const CHOICE = {
  instructions: {
    question: 'Should {path} be shown to the assistant, or hidden from it?',
    how_to_decide: [
      'Read `conversation` to understand what the user wants and what the assistant has said it is doing to get there. The assistant\'s own messages count: if it said it is looking for something, that is part of the current request.',
      'Read `tool_call.each_candidate_is` to understand what kind of thing {path} is and how much of it is known.',
      'Decide whether the assistant, doing that work, would want {path} in front of it.',
    ],
  },
  show_as_warning: {
    covers:
      'The candidate reports an error, exception, failed command, missing file or directory, permission problem, or timeout.',
    note: 'Choose this regardless of topic, so the assistant learns that something went wrong.',
  },
  /** show / hide, written separately for each kind of candidate */
  by_kind: {
    file_path: {
      show: {
        covers: 'The file\'s name or location suggests it defines, documents, configures, or implements the thing the user asked about.',
        boundary: 'Only the path is known. When the name is generic but the file could reasonably hold the answer, choose show: the assistant will open it and decide.',
      },
      hide: {
        covers: 'The file\'s name and location point to a different subject: onboarding or setup guides, unrelated features or pages, build and packaging config, generated boilerplate, version-control internals.',
        does_not_cover: 'A generically named file inside a directory named for the thing the user asked about.',
      },
    },
    matched_line: {
      show: {
        covers: 'The line itself states, defines, assigns, or documents the thing the user asked about, or names the file or variable that holds it. The full line is known, so judge its content, not just the presence of a search word.',
      },
      hide: {
        covers: 'The line contains a word from the search pattern only inside an unrelated identifier, path, or id, and says nothing about the thing the user asked about. Also boilerplate such as generated-file headers and structural punctuation.',
        does_not_cover: 'A line that describes, labels, or documents the thing the user asked about, even if it holds no value itself.',
        boundary: 'When the line matches the pattern but tells the assistant nothing it could use for the request, choose hide.',
      },
    },
    directory_entry: {
      show: { covers: 'The entry is a file or directory where the thing the user asked about would live, or a file that itself is that thing.' },
      hide: { covers: 'The entry is unrelated to the request: version-control internals, build output, dependencies, unrelated features.' },
    },
    search_hit: {
      show: { covers: 'The page title and URL indicate the page is about the thing the user asked about.' },
      hide: { covers: 'The page is about a different subject, or only shares a word with the query.' },
    },
    whole_file: {
      show: {
        covers: 'The file is one the assistant would want to read for the current work: it defines, documents, configures, or explains something the user or the assistant said they are looking for, or it is a place where that thing might be found.',
        boundary: 'The assistant chose to open this exact file. If it opened the file to check whether something is in it, show it even when the thing is absent: seeing the file is how the assistant learns that.',
      },
      hide: {
        covers: 'The file is unrelated to everything in the conversation and to anything the assistant said it was looking for, so opening it must have been a mistake, or the content is binary or generated noise nobody could use.',
        does_not_cover: 'A configuration, settings, or source file the assistant opened while looking for something, even if that something turns out not to be in it.',
      },
    },
    item: {
      show: { covers: 'The item is about, or contains information about, the thing the user asked about.' },
      hide: { covers: 'The item is about a different subject, or is boilerplate.' },
    },
  },
} as const;

/** The criteria sent for one candidate: show/hide text for its kind, plus the warning option. */
function criteriaFor(kind: CandidateKind) {
  const k = CHOICE.by_kind[kind];
  return { show: k.show, show_as_warning: CHOICE.show_as_warning, hide: k.hide };
}

type Label = 'show' | 'show_as_warning' | 'hide';
type Verdict = { choice: Label; confidence: number; show: number; show_as_warning: number; hide: number };

const BATCH = Math.max(1, Number(process.env.JEV_FILTER_BATCH ?? '30'));
const JEV_USD_PER_M_INPUT = Number(process.env.JEV_USD_PER_M_INPUT ?? '0.042'); // TypeSafe list price; output is free
const DROP_THRESHOLD = Number(process.env.JEV_FILTER_DROP_THRESHOLD ?? '0.5');
function keep(v: Verdict): boolean {
  return v.hide < DROP_THRESHOLD;
}

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? join(here, '..', '..', '..');
const logDir = join(projectDir, '.claude', 'hook-logs');

function log(entry: Record<string, unknown>) {
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(
      join(logDir, 'jev-sift.jsonl'),
      JSON.stringify({ logged_at: new Date().toISOString(), ...entry }) + '\n',
    );
  } catch {
    /* logging must never break the hook */
  }
}

/**
 * The user's own words, read from the session transcript. The latest user
 * message is what the candidates are ultimately judged against; a couple of
 * earlier ones give context for short follow-ups like "now do the same for X".
 * Tool results and injected system reminders are not user messages and are
 * skipped.
 */
type Turn = { role: 'user' | 'assistant'; text: string };

/**
 * The whole conversation so far, verbatim: every user entry and every assistant
 * text block, in order, exactly as the transcript holds them. Only tool results
 * are left out.
 */
function readConversation(transcriptPath: string | undefined): Turn[] {
  if (!transcriptPath) return [];
  let lines: string[];
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return [];
  }
  const turns: Turn[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const content = e?.message?.content;
    if (e?.type === 'user') {
      let text = '';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        if (content.some((b: any) => b?.type === 'tool_result')) continue; // tool results are not conversation
        text = content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n');
      }
      if (text) turns.push({ role: 'user', text });
    } else if (e?.type === 'assistant' && Array.isArray(content)) {
      const text = content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n');
      if (text) turns.push({ role: 'assistant', text });
    }
  }
  return turns;
}

/**
 * Jev's documented budget: 32k tokens for state plus the longest question.
 * We estimate tokens from characters and keep headroom. Candidates get first
 * claim on the budget; the conversation is trimmed from the oldest end only
 * when the two together would not fit, and every trim is logged.
 */
const STATE_TOKEN_BUDGET = Number(process.env.JEV_FILTER_STATE_TOKENS ?? '30000');
const CHARS_PER_TOKEN = 3.5;
const estTokens = (v: unknown) => Math.ceil(JSON.stringify(v).length / CHARS_PER_TOKEN);

/**
 * What the assistant just did, explained for the judge: which tool, what it
 * does, which mode it ran in, what one candidate is and how much of it is
 * known, and what happens to shown and hidden candidates.
 */
type Task = {
  tool: string;
  what_it_does: string;
  mode: string;
  arguments: Record<string, string>;
  each_candidate_is: string;
  candidate_kind: CandidateKind;
  shown_candidates: string;
  hidden_candidates: string;
};

function describeTask(input: HookInput): Task {
  const ti = input.tool_input;
  const str = (k: string) => (typeof ti[k] === 'string' ? (ti[k] as string) : undefined);
  const args = Object.fromEntries(
    Object.entries(ti).filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean').map(([k, v]) => [k, String(v)]),
  );
  const common = {
    arguments: args,
    shown_candidates: 'are delivered to the assistant, which reads them and decides its next step from them',
    hidden_candidates: 'are removed before the assistant sees the result; the assistant never learns they existed',
  };
  const ctx = usesContext(input);
  switch (input.tool_name) {
    case 'Grep': {
      const mode = str('output_mode') ?? 'files_with_matches';
      const pattern = str('pattern') ?? '';
      const where = str('path') ?? 'the project';
      if (mode === 'content') {
        return {
          tool: 'Grep', ...common,
          what_it_does: 'searches the contents of files with a regular expression',
          mode: `content: returns each matching line prefixed with its file path and line number` + (ctx ? ', together with the surrounding context lines requested' : ''),
          each_candidate_is: ctx
            ? `one match for the pattern \`${pattern}\` in files under ${where}, with its neighbouring lines; the file path and line numbers are in the text`
            : `one line from a file under ${where} that matches the pattern \`${pattern}\`; the file path and line number are in the text`,
          candidate_kind: 'matched_line',
        };
      }
      if (mode === 'count') {
        return {
          tool: 'Grep', ...common,
          what_it_does: 'searches the contents of files with a regular expression',
          mode: 'count: returns, per file, how many lines match',
          each_candidate_is: `one file path with its count of lines matching \`${pattern}\``,
          candidate_kind: 'file_path',
        };
      }
      return {
        tool: 'Grep', ...common,
        what_it_does: 'searches the contents of files with a regular expression',
        mode: 'files_with_matches: returns only the paths of files that contain at least one match; the matching text itself is not returned',
        each_candidate_is: `the path of one file under ${where} whose contents contain at least one match for the pattern \`${pattern}\`; only the path is known, not the contents, and the assistant will choose which of these files to open next`,
        candidate_kind: 'file_path',
      };
    }
    case 'Glob':
      return {
        tool: 'Glob', ...common,
        what_it_does: 'lists files whose names match a glob pattern',
        mode: 'returns matching file paths',
        each_candidate_is: `the path of one file whose name matches \`${str('pattern') ?? ''}\`; only the path is known`,
        candidate_kind: 'file_path',
      };
    case 'Read':
      return {
        tool: 'Read', ...common,
        what_it_does: 'reads one file from disk',
        mode: 'returns the whole file',
        each_candidate_is: `the complete contents of the file \`${str('file_path') ?? ''}\`, together with its path`,
        candidate_kind: 'whole_file',
      };
    case 'Bash': {
      const command = str('command') ?? '';
      const program = (command.split(/&&|\|\||[|;]/).map((seg) => seg.trim().split(/\s+/).find((t) => !/^[A-Za-z_]\w*=/.test(t)) ?? '').find((t) => t && t !== 'cd')) ?? 'a command';
      const listing = ['ls', 'find', 'fd'].includes(program);
      return {
        tool: 'Bash', ...common,
        what_it_does: `ran the shell command \`${command}\`` + (str('description') ? ` (the assistant described it as: ${str('description')})` : ''),
        mode: listing ? `${program}: lists directory entries or file paths` : `${program}: prints matching or requested text, one result per line`,
        each_candidate_is: listing
          ? `one directory entry or file path printed by \`${program}\``
          : ctx
            ? `one match printed by \`${program}\` together with its neighbouring lines`
            : `one line printed by \`${program}\``,
        candidate_kind: listing ? 'directory_entry' : 'matched_line',
      };
    }
    case 'WebSearch':
      return {
        tool: 'WebSearch', ...common,
        what_it_does: 'searches the web',
        mode: `returns result links for the query \`${str('query') ?? ''}\``,
        each_candidate_is: 'one search result: a page title and its URL; the page contents are not known',
        candidate_kind: 'search_hit',
      };
    default:
      return {
        tool: input.tool_name, ...common,
        what_it_does: input.tool_name.startsWith('mcp__') ? 'a tool from an external server, called to retrieve information' : 'a tool called to retrieve information',
        mode: 'returns a list of content items',
        each_candidate_is: 'one item of the tool result',
        candidate_kind: 'item',
      };
  }
}

/**
 * The candidates are the items the tool itself returned, exactly as it
 * returned them. `items` are those units; `set` writes the survivors back
 * into the same place so the result keeps the tool's shape.
 */
type Collection = {
  path: string;
  items: Json[];
  /** true when the tool returns exactly one item that is judged whole (Read) */
  single?: boolean;
  set: (survivors: Json[]) => Json;
};
const DROPPED_FILE_MARKER = '[jev-sift withheld this file as unrelated to the current work. This is a relevance filter, not a safety block.]';

/** Did this call ask for context lines around matches? */
function usesContext(input: HookInput): boolean {
  const ti = input.tool_input;
  if (input.tool_name === 'Grep') {
    return ['-A', '-B', '-C'].some((k) => typeof ti[k] === 'number' && (ti[k] as number) > 0);
  }
  if (input.tool_name === 'Bash') {
    return /(^|\s)(-[ABC]\s*\d+|--(after-context|before-context|context)(=|\s)\d+)/.test(String(ti.command ?? ''));
  }
  return false;
}

/** Match groups in grep/rg output: separated by lines that are exactly "--". */
function splitGroups(text: string): string[] {
  return text.split(/^--$/m).map((g) => g.replace(/^\n/, '').replace(/\n$/, '')).filter((g) => g.trim().length > 0);
}
function splitLines(text: string): string[] {
  return text.split('\n');
}

/**
 * Per-tool definition of what one result item is, taken from each tool's
 * actual response shape (see raw_response in the hook log):
 *
 *   Grep       files mode:   { filenames: [...] }            -> one filename
 *              content mode: { content: "path:ln:text\n..." } -> one match; with
 *                            -A/-B/-C, one match group (separated by "--")
 *              count mode:   { content: "path:count\n..." }   -> one file count
 *   Glob       { filenames: [...] }                           -> one filename
 *   WebSearch  { results: [{ content: [{title,url},...] }] }  -> one search hit
 *   Bash       { stdout: "..." }  rg/grep/ls/find print one result per line
 *                                 (or one group per "--" block with context)
 *   mcp__*     { content: [{type,text},...] }                 -> one content item
 *   WebFetch   { result: "<summary>" }  one item: nothing to filter, passthrough
 *   other      unknown shape: passthrough, shape logged
 */
function locate(input: HookInput): Collection | null {
  const r = input.tool_response as { [k: string]: Json } | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const arrayAt = (key: string): Collection | null =>
    Array.isArray(r[key])
      ? { path: key, items: r[key] as Json[], set: (sv) => ({ ...r, [key]: sv }) }
      : null;
  const textAt = (key: string, split: (t: string) => string[], join: string): Collection | null =>
    typeof r[key] === 'string'
      ? { path: key, items: split(r[key] as string), set: (sv) => ({ ...r, [key]: (sv as string[]).join(join) }) }
      : null;
  const context = usesContext(input);

  switch (input.tool_name) {
    case 'Grep': {
      const files = arrayAt('filenames');
      if (files && files.items.length > 0) return files;
      return context ? textAt('content', splitGroups, '\n--\n') : textAt('content', splitLines, '\n');
    }
    case 'Glob':
      return arrayAt('filenames');
    case 'Read': {
      // { type: "text", file: { filePath, content, numLines, startLine, totalLines } }
      const file = r.file;
      if (!file || typeof file !== 'object' || Array.isArray(file)) return null;
      const f = file as { [k: string]: Json };
      if (typeof f.content !== 'string') return null;
      const item = { filePath: f.filePath, content: f.content };
      return {
        path: 'file',
        items: [item],
        single: true,
        set: (survivors) =>
          survivors.length > 0
            ? r
            : { ...r, file: { ...f, content: DROPPED_FILE_MARKER, numLines: 1 } },
      };
    }
    case 'Bash':
      return context ? textAt('stdout', splitGroups, '\n--\n') : textAt('stdout', splitLines, '\n');
    case 'WebSearch': {
      // hits live in results[i].content[]; flatten across results, write back per result
      const results = r.results;
      if (!Array.isArray(results)) return null;
      const owners: { ri: number; hits: Json[] }[] = [];
      results.forEach((res, ri) => {
        const hits = res && typeof res === 'object' && !Array.isArray(res) ? (res as { [k: string]: Json }).content : null;
        if (Array.isArray(hits)) owners.push({ ri, hits });
      });
      const items = owners.flatMap((o) => o.hits);
      if (items.length === 0) return null;
      return {
        path: 'results[].content[]',
        items,
        set: (survivors) => {
          const keep = new Set(survivors);
          const next = results.map((res, ri) => {
            const o = owners.find((x) => x.ri === ri);
            if (!o) return res;
            return { ...(res as { [k: string]: Json }), content: o.hits.filter((h) => keep.has(h)) };
          });
          return { ...r, results: next };
        },
      };
    }
    default:
      if (input.tool_name.startsWith('mcp__')) return arrayAt('content');
      return null; // WebFetch (single summary) and unknown shapes: passthrough
  }
}

type JevUsage = { requests: number; inputTokens: number; outputTokens: number };
const jevUsage: JevUsage = { requests: 0, inputTokens: 0, outputTokens: 0 };

const trims: { batch_first_index: number; entries_dropped: number; entries_kept: number }[] = [];

async function judge(context: Context, items: Json[]): Promise<Verdict[]> {
  const verdicts: Verdict[] = items.map(() => ({ choice: 'show', confidence: 1, show: 1, show_as_warning: 0, hide: 0 }));
  // blank items (empty lines that separate blocks) are structure, not candidates: always kept, never asked
  const askable = items.map((it, i) => (typeof it === 'string' && it.trim().length === 0 ? -1 : i)).filter((i) => i >= 0);
  const batches: number[][] = [];
  for (let i = 0; i < askable.length; i += BATCH) batches.push(askable.slice(i, i + BATCH));
  await Promise.all(
    batches.map(async (indices) => {
      const candidates = indices.map((i) => items[i]);
      const fixed = estTokens({ tool_call: context.tool_call, candidates }) + 200; // + question text
      let conversation = context.conversation;
      let trimmed = 0;
      while (conversation.length > 0 && fixed + estTokens(conversation) > STATE_TOKEN_BUDGET) {
        conversation = conversation.slice(1);
        trimmed += 1;
      }
      if (trimmed > 0) trims.push({ batch_first_index: indices[0], entries_dropped: trimmed, entries_kept: conversation.length });
      const state = {
        guide: {
          conversation: 'every message between the user and the assistant so far, oldest first; the user\'s messages say what the assistant is trying to accomplish',
          latest_user_message: 'the most recent message from the user; the assistant is working on this now',
          tool_call: 'the tool the assistant just ran to work on the request: what it does, which mode it ran in, and what each candidate is',
          candidates: 'the items the tool returned; each question is about one of them by index',
        },
        conversation,
        latest_user_message: context.latest_user_message,
        tool_call: context.tool_call,
        candidates,
      };
      const questions = Object.fromEntries(
        indices.map((_, k) => [
          `c${k}`,
          {
            type: 'choice' as const,
            instructions: JSON.parse(JSON.stringify(CHOICE.instructions).split('{path}').join(`\`candidates[${k}]\``)),
            criteria: criteriaFor(context.tool_call.candidate_kind),
          },
        ]),
      );
      const result = await evaluateWithJev({ state, questions });
      jevUsage.requests += 1;
      jevUsage.inputTokens += result.usage.inputTokens;
      jevUsage.outputTokens += result.usage.outputTokens;
      indices.forEach((i, k) => {
        const a = result.answers[`c${k}`] as
          | { choice?: Label; confidence?: number; probabilities?: Partial<Record<Label, number>> }
          | undefined;
        if (a?.probabilities) {
          verdicts[i] = {
            choice: a.choice ?? 'show',
            confidence: a.confidence ?? 0,
            show: a.probabilities.show ?? 0,
            show_as_warning: a.probabilities.show_as_warning ?? 0,
            hide: a.probabilities.hide ?? 0,
          };
        }
      });
    }),
  );
  return verdicts;
}

/**
 * True when a search or listing tool is invoked at a command position: the
 * start of the command or right after && || | ; on the same line. Text inside
 * heredocs or quoted strings on later lines does not count.
 */
const SEARCH_TOOLS = ['rg', 'grep', 'egrep', 'fgrep', 'find', 'fd', 'ls', 'cat', 'head', 'tail', 'curl', 'wget'];
function isSearchCommand(command: string): boolean {
  const firstLine = command.split('\n')[0] ?? '';
  const segments = firstLine.split(/&&|\|\||[|;]/);
  return segments.some((seg) => {
    const tokens = seg.trim().split(/\s+/);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    return SEARCH_TOOLS.includes(tokens[i] ?? '');
  });
}

/** Plugin options arrive as CLAUDE_PLUGIN_OPTION_<KEY> in the hook's environment. */
const optionOn = (key: string) => /^(true|1|yes|on)$/i.test(process.env[`CLAUDE_PLUGIN_OPTION_${key}`] ?? '');

async function main() {
  const raw = await new Promise<string>((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
  });
  const input = JSON.parse(raw) as HookInput;
  const started = Date.now();

  // No key yet (installed without entering one): pass through and leave a marker the status line shows.
  const keyMarker = join(process.env.HOME ?? '', '.claude', 'jev-sift', 'needs-key');
  if (!process.env.TYPESAFE_API_KEY) {
    try { mkdirSync(join(process.env.HOME ?? '', '.claude', 'jev-sift'), { recursive: true }); appendFileSync(keyMarker, ''); } catch { /* ignore */ }
    log({ session_id: input.session_id, tool_name: input.tool_name, action: 'passthrough', reason: 'no TypeSafe API key configured' });
    return;
  }
  try { if (existsSync(keyMarker)) unlinkSync(keyMarker); } catch { /* ignore */ }
  if (optionOn('PAUSED')) {
    log({ session_id: input.session_id, tool_name: input.tool_name, action: 'passthrough', reason: 'paused' });
    return;
  }
  if (input.tool_name === 'Bash' && !isSearchCommand(String(input.tool_input.command ?? ''))) {
    log({ session_id: input.session_id, tool_name: 'Bash', action: 'passthrough', reason: 'not a search command' });
    return;
  }
  const collection = locate(input);
  if (!collection || (!collection.single && collection.items.length < 2) || process.env.JEV_FILTER_DISABLED === '1') {
    log({
      session_id: input.session_id,
      tool_name: input.tool_name,
      action: 'passthrough',
      reason: !collection ? 'tool returns a single item or unknown shape' : collection.items.length < 2 ? 'fewer than 2 items' : 'disabled',
      response_shape: summarizeShape(input.tool_response),
      tool_input: input.tool_input,
      raw_response: JSON.stringify(input.tool_response).slice(0, 3000),
    });
    return;
  }

  // Lossless check: putting every candidate back with nothing dropped must
  // reproduce the tool's result exactly. If it does not, the split is wrong
  // and we refuse to filter.
  const lossless = JSON.stringify(collection.set(collection.items)) === JSON.stringify(input.tool_response);
  if (process.env.JEV_FILTER_DRY_RUN === '1' || !lossless) {
    log({
      session_id: input.session_id,
      tool_name: input.tool_name,
      action: lossless ? 'dry_run' : 'passthrough',
      reason: lossless ? 'dry run: candidates prepared, Jev not called' : 'split is not lossless, refusing to filter',
      lossless,
      collection_path: collection.path,
      total: collection.items.length,
      raw_response: JSON.stringify(input.tool_response).slice(0, 6000),
      candidates: collection.items,
    });
    return;
  }

  const conversation = readConversation(input.transcript_path);
  const context: Context = {
    conversation,
    latest_user_message: [...conversation].reverse().find((t) => t.role === 'user')?.text ?? '',
    tool_call: describeTask(input),
  };
  const verdicts = await judge(context, collection.items);
  const survivors = collection.items.filter((_, i) => keep(verdicts[i]));
  const updatedToolOutput = collection.set(survivors);

  log({
    session_id: input.session_id,
    tool_name: input.tool_name,
    action: 'filtered',
    context: {
      conversation_entries: context.conversation.length,
      conversation_chars: JSON.stringify(context.conversation).length,
      conversation_last: context.conversation.slice(-2),
      tool_call: context.tool_call,
    },
    conversation_trims: trims,
    lossless,
    raw_response: JSON.stringify(input.tool_response).slice(0, 4000),
    collection_path: collection.path,
    drop_threshold: DROP_THRESHOLD,
    total: collection.items.length,
    kept: survivors.length,
    dropped: collection.items.length - survivors.length,
    elapsed_ms: Date.now() - started,
    original_chars: JSON.stringify(input.tool_response).length,
    filtered_chars: JSON.stringify(updatedToolOutput).length,
    chars_removed: JSON.stringify(input.tool_response).length - JSON.stringify(updatedToolOutput).length,
    jev_usage: { ...jevUsage, est_cost_usd: (jevUsage.inputTokens / 1_000_000) * JEV_USD_PER_M_INPUT },
    decisions: collection.items.map((item, i) => ({
      i,
      ...verdicts[i],
      kept: keep(verdicts[i]),
      candidate: JSON.stringify(item).slice(0, 200),
    })),
  });

  const out: Record<string, unknown> = { hookEventName: 'PostToolUse', updatedToolOutput };
  if (process.env.JEV_FILTER_NOTE === '1') {
    out.additionalContext = `Jev filter kept ${survivors.length} of ${collection.items.length} candidates at ${collection.path} (hide threshold ${DROP_THRESHOLD}).`;
  }
  const hidden = collection.items.length - survivors.length;
  const payload: Record<string, unknown> = { hookSpecificOutput: out };
  // Optional transcript line for the user (never sent to the model). Off unless JEV_FILTER_SHOW=1.
  if (hidden > 0 && process.env.JEV_FILTER_SHOW === '1') {
    const kind = context.tool_call.candidate_kind.replace('_', ' ');
    payload.systemMessage = `Jev filter: hid ${hidden} of ${collection.items.length} ${kind}${collection.items.length === 1 ? '' : 's'} from ${input.tool_name} (see .claude/hook-logs/sift.jsonl)`;
  }
  process.stdout.write(JSON.stringify(payload));
}

/** Compact description of a result's shape, for the log when we pass through. */
function summarizeShape(value: Json, depth = 0): unknown {
  if (Array.isArray(value)) return `array(${value.length})` + (value.length && depth < 2 ? `<${JSON.stringify(summarizeShape(value[0], depth + 1))}>` : '');
  if (value && typeof value === 'object') {
    if (depth >= 2) return 'object';
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, summarizeShape(v, depth + 1)]));
  }
  if (typeof value === 'string') return `string(${value.length})`;
  return typeof value;
}

main().catch((error) => {
  log({ action: 'error', message: error instanceof Error ? error.message : String(error) });
});
