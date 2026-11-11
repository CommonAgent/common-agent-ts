// topic-digest.mjs: reads the current top stories on Hacker News and writes a
// short Markdown digest of the ones about the topic the caller names.
//
// Run (as the host runs it):
//   node topic-digest.mjs --job <job_dir> --records <records> --work <work> --text-file <job_dir>/message.txt
//
// The job folder and records folder come only from --job and --records.
// The topic is the job's own topic input (<job_dir>/inputs.json or
// <job_dir>/inputs/topic) where it carries one, else the message text. A brand
// profile or style guide among the job's inputs guides the sentences.
//
// What it needs from the environment:
//   HACKER_NEWS_ADDRESS   the base address of the Hacker News API (read only)
//   MODEL_NAME, MODEL_ENDPOINT, MODEL_KEY (may be empty), MODEL_PROTOCOL
//                         (anthropic-messages, openai-chat or gemini)
//   TOP_STORIES_TO_READ   optional, default 30, 10..100 (a job may set its own)
//   STORIES_IN_DIGEST     optional, default 5, 1..10 (a job may set its own)
//
// It delivers one piece, digest (text/markdown), as <job_dir>/out/digest listed
// in <job_dir>/pieces.json, and prints one JSON object whose reply member is
// the words the sender reads.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── The words the agent's files fix ─────────────────────────────────────────

const REFUSE_UNREAD = "Writing about stories it did not read from Hacker News. It relies entirely on the fetched data for factual accuracy, so it outputs nothing if the top stories cannot be retrieved.";
const REFUSE_INVENTED = "Inventing points, links or comments. It strictly reports the exact metadata retrieved from the source, so the digest always reflects real community metrics rather than fabricated numbers.";
const REFUSE_ACTIONS = "Posting, voting or commenting on Hacker News. It operates with strictly read-only access to the public API, so it never interacts with or alters the community platform on your behalf.";
const REFUSE_OFF_TOPIC = "Summarizing stories outside the provided topic. It filters the top stories strictly by the subject handed to it, so irrelevant items are dropped entirely from the final output.";
const REPLY_EMPTY = "If no top stories match the requested topic, it returns a plain document stating that no matches were found in the current top list, without inventing any news.";
const REPLY_DONE = "A markdown document listing the matching stories, where each item clearly displays its real title, link, points, and exactly one plain sentence explaining why it matters.";
const REPLY_NO_TOPIC = "Name the topic the digest is about, for example: topic: databases";

/** C1: the model writing the sentences is held to 1 USD per day. */
const SPENDING_CEILING_USD = 1;

/** run_config settings, as agent-descriptor.json declares them. */
const SETTINGS = {
  top_stories_to_read: { default: 30, min: 10, max: 100 },
  stories_in_digest: { default: 5, min: 1, max: 10 },
};

const DISALLOWED_ACTIONS = new Set(["post", "vote", "upvote", "downvote", "comment", "reply", "submit", "flag", "flag_story"]);

class Refusal extends Error {}
/** Every story the model returned was off the topic, so all were dropped. */
class OffTopic extends Refusal {}

// ── Settings ────────────────────────────────────────────────────────────────

function clampSetting(name, raw) {
  const s = SETTINGS[name];
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(n)) return null;
  return Math.max(s.min, Math.min(s.max, n));
}

/** A job's own values: `name: value` lines in its message, or settings.json in
 *  its folder. */
function jobSettings(text, jobDir) {
  const own = {};
  const at = jobDir ? join(jobDir, "settings.json") : null;
  if (at && existsSync(at)) {
    try {
      const doc = JSON.parse(readFileSync(at, "utf8"));
      for (const name of Object.keys(SETTINGS)) if (doc && doc[name] != null) own[name] = doc[name];
    } catch { /* not readable: the environment's values stand */ }
  }
  for (const name of Object.keys(SETTINGS)) {
    const m = new RegExp(`^\\s*${name}\\s*[:=]\\s*(\\d+)\\s*$`, "im").exec(String(text ?? ""));
    if (m) own[name] = m[1];
  }
  return own;
}

function resolveSettings(env, own) {
  const out = {};
  for (const name of Object.keys(SETTINGS)) {
    out[name] = clampSetting(name, own[name]) ?? clampSetting(name, env[name.toUpperCase()]) ?? SETTINGS[name].default;
  }
  return out;
}

// ── The job's own inputs ────────────────────────────────────────────────────

const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** The inputs the job carries: <job>/inputs.json (an object of name: value, or
 *  a list of { name, value }) and each file in <job>/inputs/, named by its
 *  file name without the extension (a .json file is read as JSON). */
export function jobInputs(jobDir) {
  const out = {};
  if (!jobDir) return out;
  const at = join(jobDir, "inputs.json");
  if (existsSync(at)) {
    const doc = parseJson(readFileSync(at, "utf8"));
    if (Array.isArray(doc)) {
      for (const it of doc) if (it && typeof it.name === "string") out[it.name] = it.value ?? it.content ?? it.text;
    } else if (doc && typeof doc === "object") {
      Object.assign(out, doc);
    }
  }
  const dir = join(jobDir, "inputs");
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    for (const file of readdirSync(dir)) {
      const path = join(dir, file);
      if (!statSync(path).isFile()) continue;
      const ext = extname(file);
      const name = basename(file, ext);
      const raw = readFileSync(path, "utf8");
      out[name] = ext.toLowerCase() === ".json" ? parseJson(raw) ?? raw : raw;
    }
  }
  return out;
}

/** The topic input, where the job carries one. */
function inputTopic(inputs) {
  const v = inputs?.topic;
  const s = typeof v === "string" ? v : v && typeof v === "object" && typeof v.value === "string" ? v.value : "";
  return s.replace(/\s+/g, " ").trim() || null;
}

const BRAND_SCHEMA = "https://schemas.example.org/brand/v1";
const STYLE_SCHEMA = "https://schemas.example.org/style-guide/v1";
const BRAND_NAMES = ["brand", "brand_profile", "brand-profile", "brandProfile"];
const STYLE_NAMES = ["style_guide", "style-guide", "styleGuide", "style"];

const pick = (doc, path) => path.split(".").reduce((v, k) => (v && typeof v === "object" ? v[k] : undefined), doc);

/** Only the members can_use says it reads. */
function readsOf(doc, paths) {
  const out = {};
  for (const p of paths) {
    const v = pick(doc, p);
    if (v !== undefined && v !== null && v !== "") out[p] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** The brand profile and style guide the job is given, if any: by input name,
 *  or by the schema a JSON input names. */
export function jobGuidance(inputs) {
  const docs = Object.entries(inputs ?? {}).map(([name, v]) => [name, typeof v === "string" ? parseJson(v) ?? null : v]);
  const schemaOf = (d) => String(d?.$schema ?? d?.schema ?? "");
  const find = (names, schema) => {
    for (const [name, d] of docs) if (d && typeof d === "object" && schemaOf(d).startsWith(schema)) return d;
    for (const [name, d] of docs) if (d && typeof d === "object" && names.includes(name)) return d;
    return null;
  };
  const brandDoc = find(BRAND_NAMES, BRAND_SCHEMA);
  const styleDoc = find(STYLE_NAMES, STYLE_SCHEMA);
  return {
    brand: brandDoc ? readsOf(brandDoc, ["name", "legal.first_mention", "words.instead_of", "words.never_say"]) : null,
    style: styleDoc ? readsOf(styleDoc, ["voice", "tone", "spelling", "words.prefer", "words.avoid"]) : null,
  };
}

function guidanceLines(guidance) {
  const lines = [];
  if (guidance?.brand) {
    lines.push(
      "Brand profile: write the organization's name as the brand writes it, use its first-mention form the first time, use its words in place of the ones it lists, and never use the words it never says.",
      JSON.stringify(guidance.brand),
    );
  }
  if (guidance?.style) {
    lines.push(
      "Style guide: write in this voice, tone and spelling, and use the words it prefers in place of the ones it avoids.",
      JSON.stringify(guidance.style),
    );
  }
  if (!lines.length) lines.push("Write in a plain, neutral voice, in the spelling of the words given.");
  return lines;
}

function guidanceNote(guidance) {
  const brand = Boolean(guidance?.brand);
  const style = Boolean(guidance?.style);
  if (!brand && !style) return "_No brand profile or style guide was given, so this is written in a plain, neutral voice._";
  if (!brand) return "_No brand profile was given; the sentences follow the style guide given._";
  if (!style) return "_No style guide was given, so the sentences are in a plain, neutral voice that follows the brand profile given._";
  return "_The sentences follow the brand profile and style guide given._";
}

// ── The steps ───────────────────────────────────────────────────────────────

/** The topic the message names (or `given`, the job's own topic input).
 *  Refuses a request to post, vote or comment. */
export async function extractTopic(text, callModel, given = null) {
  const message = String(text ?? "").trim();
  if (!message) return given || null;
  const local = /^\s*topic\s*:\s*(.+?)\s*$/im.exec(message)?.[1] ?? null;
  const prompt = [
    "You read a request sent to a read-only Hacker News digest agent.",
    "Say what the request asks for and the topic it names.",
    'Answer with one JSON object only: {"action": "digest" | "post" | "vote" | "comment" | "other", "topic": "<the topic, or empty>"}.',
    "Use post, vote or comment when the request asks to post, submit, vote, upvote, flag, reply or comment on Hacker News.",
    "",
    "Request:",
    message,
  ].join("\n");
  const answer = await callModel(prompt, { purpose: "extract_topic", spending_ceiling_usd: SPENDING_CEILING_USD });
  const doc = typeof answer === "string" ? parseJson(answer) : answer;
  const action = String(doc?.action ?? "").trim().toLowerCase();
  if (DISALLOWED_ACTIONS.has(action)) throw new Refusal(REFUSE_ACTIONS);
  const topic = given || (local ?? (typeof doc?.topic === "string" ? doc.topic.trim() : ""));
  return topic || null;
}

/** The first `limit` top stories, read from the Hacker News API at `base`.
 *  Refuses when they cannot be read. */
export async function fetchTopStories(base, limit, fetchImpl = globalThis.fetch) {
  const root = String(base ?? "").replace(/\/+$/, "");
  const getJson = async (path) => {
    const res = await fetchImpl(`${root}${path}`, { method: "GET" });
    if (!res || res.ok === false) throw new Error(`status ${res?.status ?? "unknown"}`);
    return res.json();
  };
  try {
    const ids = await getJson("/topstories.json");
    if (!Array.isArray(ids)) throw new Error("topstories is not a list");
    const wanted = ids.slice(0, limit);
    const items = await Promise.all(wanted.map((id) => getJson(`/item/${encodeURIComponent(id)}.json`)));
    return items.filter((it) => it && typeof it === "object" && !it.deleted && !it.dead && (it.type == null || it.type === "story"));
  } catch {
    throw new Refusal(REFUSE_UNREAD);
  }
}

/** The stories about the topic, each with one sentence on why it matters,
 *  held to what was fetched. At most `limit`. */
export async function filterAndSummarize(topic, stories, limit, callModel, guidance = null) {
  const fetched = new Map();
  for (const s of stories ?? []) if (s && s.id != null) fetched.set(String(s.id), s);
  const listed = [...fetched.values()].map((s) => ({ id: s.id, title: s.title, url: s.url ?? null, score: s.score ?? null }));
  const prompt = [
    `You pick, from the Hacker News top stories below, the ones about the topic "${topic}", at most ${limit}.`,
    "For each one, write exactly one plain sentence on why it matters.",
    "Copy id, title, url and score exactly as given; never change or add any of them.",
    'Answer with one JSON object only: {"summaries": [{"id": <id>, "title": "...", "url": "...", "score": <score>, "topic_match": true, "sentence": "..."}]}.',
    'When none is about the topic, answer {"summaries": []}.',
    ...guidanceLines(guidance),
    "",
    "Stories:",
    JSON.stringify(listed),
  ].join("\n");
  const answer = await callModel(prompt, { purpose: "filter_and_summarize", limit, spending_ceiling_usd: SPENDING_CEILING_USD });
  const doc = typeof answer === "string" ? parseJson(answer) : answer;
  const summaries = Array.isArray(doc?.summaries) ? doc.summaries : [];
  const out = [];
  let offTopic = 0;
  for (const m of summaries) {
    const story = fetched.get(String(m?.id));
    if (!story) throw new Refusal(REFUSE_UNREAD);
    // A story the model marks off the topic is dropped from the digest.
    if (m.topic_match === false || String(m.topic_match).trim().toLowerCase() === "false") { offTopic += 1; continue; }
    const same = (k) => m[k] === undefined || m[k] === null && story[k] == null || String(m[k]) === String(story[k]);
    if (!same("title") || !same("url") || !same("score") || m.comments !== undefined || m.descendants !== undefined && String(m.descendants) !== String(story.descendants)) {
      throw new Refusal(REFUSE_INVENTED);
    }
    if (!story.url) continue; // no link was read, so none is written
    const sentence = String(m.sentence ?? "").replace(/\s+/g, " ").trim();
    if (!sentence) continue;
    out.push({ id: story.id, title: String(story.title ?? ""), url: String(story.url), score: Number(story.score ?? 0), sentence });
  }
  // Every story the model returned was off the topic: all were dropped, and
  // the caller hands back the empty digest rather than failing the job.
  if (!out.length && offTopic > 0) throw new OffTopic(REFUSE_OFF_TOPIC);
  return out.slice(0, limit);
}

// ── The digest ──────────────────────────────────────────────────────────────

const mdText = (s) => String(s).replace(/([\\[\]])/g, "\\$1");

function digestMarkdown(topic, readAt, items, guidance = null) {
  const lines = [
    "# Hacker News digest",
    "",
    "<!-- header: topic, read_at -->",
    `topic: ${String(topic).replace(/\s+/g, " ")}`,
    `read_at: ${readAt}`,
    "",
    "## Stories",
    "",
  ];
  if (!items.length) lines.push("No current top story was about the topic.");
  for (const it of items) {
    lines.push(`- [${mdText(it.title)}](<${it.url}>) (${it.score} points): ${it.sentence}`);
  }
  lines.push("", guidanceNote(guidance), "");
  return lines.join("\n");
}

// ── The model, through its four settings ────────────────────────────────────

function modelCallerFrom(env, fetchImpl = globalThis.fetch) {
  return async function callModel(prompt) {
    const name = String(env.MODEL_NAME ?? "").trim();
    const endpoint = String(env.MODEL_ENDPOINT ?? "").trim().replace(/\/+$/, "");
    const key = String(env.MODEL_KEY ?? "");
    const protocol = String(env.MODEL_PROTOCOL ?? "").trim();
    if (!name || !endpoint || !protocol) throw new Error("MODEL_NAME, MODEL_ENDPOINT and MODEL_PROTOCOL are required");
    let url; let headers = { "content-type": "application/json" }; let body;
    if (protocol === "anthropic-messages") {
      url = /\/messages$/.test(endpoint) ? endpoint : `${endpoint}/v1/messages`;
      if (key) headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
      body = { model: name, max_tokens: 2048, messages: [{ role: "user", content: prompt }] };
    } else if (protocol === "openai-chat") {
      url = /\/chat\/completions$/.test(endpoint) ? endpoint : `${endpoint}/chat/completions`;
      if (key) headers.authorization = `Bearer ${key}`;
      body = { model: name, messages: [{ role: "user", content: prompt }] };
    } else if (protocol === "gemini") {
      url = /:generateContent$/.test(endpoint) ? endpoint : `${endpoint}/models/${encodeURIComponent(name)}:generateContent`;
      if (key) headers["x-goog-api-key"] = key;
      body = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
    } else {
      throw new Error(`MODEL_PROTOCOL ${protocol} is not one this agent speaks`);
    }
    const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`the model answered ${res.status}`);
    const doc = await res.json();
    let text = "";
    if (protocol === "anthropic-messages") text = (doc?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("");
    else if (protocol === "openai-chat") text = doc?.choices?.[0]?.message?.content ?? "";
    else text = (doc?.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text ?? "").join("");
    const m = /\{[\s\S]*\}/.exec(String(text));
    return m ? parseJson(m[0]) ?? {} : {};
  };
}

// ── The job ─────────────────────────────────────────────────────────────────

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { out[a.slice(2)] = argv[i + 1]; i += 1; }
      else out[a.slice(2)] = "";
    }
  }
  return out;
}

/** One job, start to end. Returns { code, reply }. */
export async function runJob({ argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch, callModel } = {}) {
  const f = flags(argv);
  const jobDir = f.job;
  const records = f.records;
  if (!jobDir || !records) return { code: 2, reply: "JOB_DIR and RECORDS are required: pass --job and --records." };
  const textFile = f["text-file"] || join(jobDir, "message.txt");
  const text = existsSync(textFile) ? readFileSync(textFile, "utf8") : "";
  const model = callModel ?? modelCallerFrom(env, fetchImpl);
  const settings = resolveSettings(env, jobSettings(text, jobDir));
  try {
    const inputs = jobInputs(jobDir);
    const guidance = jobGuidance(inputs);
    const topic = await extractTopic(text, model, inputTopic(inputs));
    if (!topic) return { code: 2, reply: REPLY_NO_TOPIC };
    const stories = await fetchTopStories(env.HACKER_NEWS_ADDRESS ?? "", settings.top_stories_to_read, fetchImpl);
    const readAt = new Date().toISOString();
    let items = [];
    let refused = null;
    if (stories.length) try {
      items = await filterAndSummarize(topic, stories, settings.stories_in_digest, model, guidance);
    } catch (e) {
      // All dropped as off the topic: the empty digest still goes out, and the
      // declared refusal is said in the reply beside it.
      if (e instanceof OffTopic) { items = []; refused = e.message; }
      else throw e;
    }
    const outDir = join(jobDir, "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "digest"), digestMarkdown(topic, readAt, items, guidance));
    writeFileSync(join(jobDir, "pieces.json"), `${JSON.stringify([{ name: "digest", path: "out/digest", media_type: "text/markdown" }], null, 2)}\n`);
    // No story fetched, or none on the topic: the digest still goes out, with
    // the header and a line saying so, and no story invented.
    if (!items.length) return { code: 3, reply: refused ? `${refused}\n\n${REPLY_EMPTY}` : REPLY_EMPTY };
    return { code: 0, reply: REPLY_DONE };
  } catch (e) {
    if (e instanceof Refusal) return { code: 4, reply: e.message };
    return { code: 1, reply: `The digest could not be written: ${e?.message ?? e}` };
  }
}

const ranDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (ranDirectly) {
  const out = await runJob();
  process.stdout.write(`${JSON.stringify({ reply: out.reply })}\n`);
  process.exitCode = out.code;
}
