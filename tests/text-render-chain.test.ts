/**
 * Measuring, rendering and chaining — the three places a connector is silently
 * wrong for every reader whose alphabet is not ASCII.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { byteRangeOf, graphemes, linkRanges, measure, sliceByteRange, utf8Length } from "../src/text.ts";
import { isEmptyPayload, payloadHash, render, RENDERER_VERSION, splitToFit } from "../src/render.ts";
import { postChain } from "../src/chain.ts";

test("graphemes counts what a person means by a character", () => {
  assert.equal(graphemes("hello"), 5);
  assert.equal(graphemes("👍"), 1, ".length would say 2");
  assert.equal(graphemes("👨‍👩‍👧"), 1, ".length would say 8");
  assert.equal(graphemes("café"), 4);
  // The failure this prevents: a post that passes our check and is refused by
  // the server, which reads as the network being flaky rather than as our bug.
  assert.ok("👨‍👩‍👧".length > graphemes("👨‍👩‍👧"));
});

test("measure honours the unit the provider actually enforces", () => {
  assert.equal(measure("café", "characters"), 4);
  assert.equal(measure("café", "graphemes"), 4);
  assert.equal(measure("café", "utf8-bytes"), 5, "é is two bytes");
  assert.equal(utf8Length("👍"), 4);
});

test("a byte range is a byte range, and an emoji shifts it", () => {
  const ascii = "see https://example.test now";
  const emoji = "👍 https://example.test now";

  const asciiRange = byteRangeOf(ascii, ascii.indexOf("https"), "https://example.test");
  const emojiRange = byteRangeOf(emoji, emoji.indexOf("https"), "https://example.test");

  assert.equal(asciiRange.byteStart, 4);
  // A character-index implementation would say 2 here and corrupt the LINK,
  // so the post looks fine and goes somewhere wrong.
  assert.equal(emojiRange.byteStart, 5, "👍 is four UTF-8 bytes plus the space");
  assert.equal(sliceByteRange(emoji, emojiRange), "https://example.test");
});

test("link ranges skip trailing punctuation and survive accents", () => {
  const text = "Café at https://example.test/a, and https://example.test/b.";
  const ranges = linkRanges(text);

  assert.deepEqual(
    ranges.map((range) => range.url),
    ["https://example.test/a", "https://example.test/b"],
  );
  for (const range of ranges) {
    assert.equal(sliceByteRange(text, range), range.url, "every range points at its own url");
  }
});

test("render leaves short text alone and reports no problems", () => {
  const payload = render("short", { limit: 300, unit: "graphemes", thread: true, label: "Example" });

  assert.equal(payload.segments.length, 1);
  assert.equal(payload.segments[0]?.text, "short");
  assert.deepEqual(payload.problems, []);
  assert.equal(payload.rendererVersion, RENDERER_VERSION);
});

test("render refuses rather than splitting where there is no thread mechanism", () => {
  const payload = render("x".repeat(50), { limit: 10, unit: "characters", thread: false, label: "Example" });

  assert.equal(payload.segments.length, 1, "nothing was invented");
  assert.equal(payload.problems.length, 1);
  assert.ok(payload.problems[0]?.includes("no thread mechanism"));
});

test("a thread numbers its parts and pays for the numbering BEFORE splitting", () => {
  const sentence = "This is a sentence that is long enough to need splitting. ";
  const payload = render(sentence.repeat(6), {
    limit: 60,
    unit: "characters",
    thread: true,
    label: "Example",
  });

  assert.ok(payload.segments.length > 1);
  for (const segment of payload.segments) {
    assert.ok(segment.count <= 60, `segment over limit: ${segment.count} — ${segment.text}`);
  }
  assert.ok(payload.segments[0]?.text.endsWith(`(1/${payload.segments.length})`));
  assert.deepEqual(payload.problems, [], "a clean split reports nothing");
});

test("loss is REPORTED, never applied", () => {
  const monster = `https://example.test/${"a".repeat(400)}`;
  const { parts, problems } = splitToFit(monster, 50, "characters");

  assert.equal(parts.length, 0, "nothing was hard-cut");
  assert.equal(problems.length, 1);
  assert.ok(problems[0]?.includes("cannot be split"));
});

test("link ranges are computed PER SEGMENT, not sliced from the original", () => {
  const text = `${"word ".repeat(20)}https://example.test/x ${"word ".repeat(20)}`;
  const payload = render(text, { limit: 60, unit: "characters", thread: true, label: "X", links: true });

  const carrying = payload.segments.filter((segment) => (segment.links?.length ?? 0) > 0);
  assert.equal(carrying.length, 1);
  const segment = carrying[0]!;
  assert.equal(sliceByteRange(segment.text, segment.links![0]!), "https://example.test/x");
});

test("render is pure — same input, same output, no clock", () => {
  const rules = { limit: 40, unit: "characters", thread: true, label: "X" } as const;
  const first = render("A sentence. Another sentence. A third one here.", rules);
  const second = render("A sentence. Another sentence. A third one here.", rules);

  assert.deepEqual(first, second);
});

test("the renderer version is INSIDE the payload hash", async () => {
  const payload = render("hello", { limit: 100, unit: "characters", thread: true, label: "X" });
  const same = await payloadHash(payload);
  const bumped = await payloadHash({ ...payload, rendererVersion: "render@2" });

  assert.equal(same, await payloadHash(payload), "stable");
  assert.notEqual(same, bumped, "a version change invalidates an approval");
});

test("an empty payload is recognisable, because the sha of nothing is a valid sha", () => {
  assert.equal(isEmptyPayload(render("   ", { limit: 10, unit: "characters", thread: true, label: "X" })), true);
  assert.equal(isEmptyPayload(render("x", { limit: 10, unit: "characters", thread: true, label: "X" })), false);
});

/* ── chaining ─────────────────────────────────────────────────────────────── */

type Ref = { uri: string; cid: string };

const fakePoster = (): {
  post: (text: string, links: { root: Ref; parent: Ref } | undefined) => Promise<Ref>;
  calls: Array<{ text: string; links: { root: Ref; parent: Ref } | undefined }>;
} => {
  const calls: Array<{ text: string; links: { root: Ref; parent: Ref } | undefined }> = [];
  let n = 0;

  return {
    calls,
    post: async (text, links) => {
      calls.push({ text, links });
      n += 1;

      return { uri: `at://post/${n}`, cid: `cid${n}` };
    },
  };
};

test("THE RULE — root is fixed at the top, parent advances", async () => {
  const { post, calls } = fakePoster();
  const outcome = await postChain(["one", "two", "three"], undefined, post);

  assert.equal(outcome.posted.length, 3);
  assert.equal(calls[0]?.links, undefined, "the first is top-level");
  assert.deepEqual(calls[1]?.links, {
    root: { uri: "at://post/1", cid: "cid1" },
    parent: { uri: "at://post/1", cid: "cid1" },
  });
  assert.deepEqual(
    calls[2]?.links,
    { root: { uri: "at://post/1", cid: "cid1" }, parent: { uri: "at://post/2", cid: "cid2" } },
    "reverse these and every message attaches to the first: a fan, not a thread",
  );
});

test("answering somebody else keeps THEIR root", async () => {
  const { post, calls } = fakePoster();
  const answering = { root: { uri: "at://theirs/1", cid: "t1" }, parent: { uri: "at://theirs/9", cid: "t9" } };

  await postChain(["a", "b"], answering, post);

  assert.deepEqual(calls[0]?.links, answering);
  assert.deepEqual(calls[1]?.links, { root: answering.root, parent: { uri: "at://post/1", cid: "cid1" } });
});

test("a chain stops at the first failure and reports what it posted", async () => {
  let n = 0;
  const outcome = await postChain<Ref>(["a", "b", "c"], undefined, async () => {
    n += 1;
    if (n === 2) throw new Error("boom");

    return { uri: `at://post/${n}`, cid: `cid${n}` };
  });

  assert.equal(outcome.posted.length, 1, "no hole is papered over");
  assert.equal(outcome.failed?.index, 1);
  assert.equal(n, 2, "it did not carry on past the failure");
});
