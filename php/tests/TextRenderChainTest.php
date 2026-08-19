<?php

declare(strict_types=1);

use ParticleAcademy\Connectors\Chain;
use ParticleAcademy\Connectors\ChainLinks;
use ParticleAcademy\Connectors\Render;
use ParticleAcademy\Connectors\RenderRules;
use ParticleAcademy\Connectors\Text;
use ParticleAcademy\Connectors\TextUnit;

/**
 * Measuring, rendering and chaining — the three places a connector is silently
 * wrong for every reader whose alphabet is not ASCII.
 */
$family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
$thumbsUp = "\u{1F44D}";

/* ── measuring ────────────────────────────────────────────────────────────── */

it('counts what a person means by a character', function () use ($family, $thumbsUp) {
    expect(Text::graphemes('hello'))->toBe(5)
        ->and(Text::graphemes($thumbsUp))->toBe(1, 'strlen would say 4')
        ->and(Text::graphemes($family))->toBe(1, 'mb_strlen would say 5, strlen 18')
        ->and(Text::graphemes('café'))->toBe(4);

    // The failure this prevents: a message that passes our check and is refused
    // by the server, which reads as the network being flaky rather than as our
    // bug.
    expect(strlen($family))->toBeGreaterThan(Text::graphemes($family))
        ->and(mb_strlen($family))->toBeGreaterThan(Text::graphemes($family));
});

it('honours the unit the provider actually enforces', function () use ($thumbsUp) {
    expect(Text::measure('café', TextUnit::Characters))->toBe(4)
        ->and(Text::measure('café', TextUnit::Graphemes))->toBe(4)
        ->and(Text::measure('café', TextUnit::Utf8Bytes))->toBe(5, 'é is two bytes')
        ->and(Text::utf8Length($thumbsUp))->toBe(4);
});

it('shifts a byte range by a multibyte character', function () use ($thumbsUp) {
    $ascii = 'see https://example.test now';
    $emoji = $thumbsUp.' https://example.test now';

    $asciiRange = Text::byteRangeOf($ascii, mb_strpos($ascii, 'https'), 'https://example.test');
    $emojiRange = Text::byteRangeOf($emoji, mb_strpos($emoji, 'https'), 'https://example.test');

    expect($asciiRange->byteStart)->toBe(4)
        // A character-index implementation would say 2 here and corrupt the
        // LINK, so the message looks fine and goes somewhere wrong.
        ->and($emojiRange->byteStart)->toBe(5, 'the thumbs-up is four UTF-8 bytes, plus the space')
        ->and(Text::sliceByteRange($emoji, $emojiRange))->toBe('https://example.test');
});

it('skips trailing punctuation on a link and survives accents', function () {
    $text = 'Café at https://example.test/a, and https://example.test/b.';
    $ranges = Text::linkRanges($text);

    expect(array_map(static fn ($range) => $range->url, $ranges))
        ->toBe(['https://example.test/a', 'https://example.test/b']);

    foreach ($ranges as $range) {
        expect(Text::sliceByteRange($text, $range))->toBe($range->url, 'every range points at its own url');
    }
});

/* ── rendering ────────────────────────────────────────────────────────────── */

it('leaves short text alone and reports no problems', function () {
    $payload = Render::render('short', new RenderRules(300, TextUnit::Graphemes, true, 'Example'));

    expect($payload->segments)->toHaveCount(1)
        ->and($payload->segments[0]->text)->toBe('short')
        ->and($payload->problems)->toBe([])
        ->and($payload->rendererVersion)->toBe(Render::RENDERER_VERSION);
});

it('refuses rather than splitting where there is no thread mechanism', function () {
    $payload = Render::render(str_repeat('x', 50), new RenderRules(10, TextUnit::Characters, false, 'Example'));

    expect($payload->segments)->toHaveCount(1, 'nothing was invented')
        ->and($payload->problems)->toHaveCount(1)
        ->and($payload->problems[0])->toContain('no thread mechanism');
});

it('numbers a thread and pays for the numbering BEFORE splitting', function () {
    $sentence = 'This is a sentence that is long enough to need splitting. ';
    $payload = Render::render(str_repeat($sentence, 6), new RenderRules(60, TextUnit::Characters, true, 'Example'));

    expect(count($payload->segments))->toBeGreaterThan(1);

    foreach ($payload->segments as $segment) {
        expect($segment->count)->toBeLessThanOrEqual(60, "segment over limit: {$segment->text}");
    }

    expect($payload->segments[0]->text)->toEndWith('(1/'.count($payload->segments).')')
        ->and($payload->problems)->toBe([], 'a clean split reports nothing');
});

it('REPORTS loss rather than applying it', function () {
    $monster = 'https://example.test/'.str_repeat('a', 400);
    $split = Render::splitToFit($monster, 50, TextUnit::Characters);

    expect($split->parts)->toBe([], 'nothing was hard-cut')
        ->and($split->problems)->toHaveCount(1)
        ->and($split->problems[0])->toContain('cannot be split');
});

it('never splits a URL containing dots across two segments', function () {
    // THE reason SENTENCE_BOUNDARY demands whitespace after a terminator. A
    // regex treating every `.` as a sentence end splits inside the host, and the
    // link lands across two messages — a link that goes nowhere, from copy that
    // looked fine in review.
    $url = 'https://example.test/a.b.c/d.e';
    $text = str_repeat('word ', 12).$url.' '.str_repeat('word ', 12);

    $payload = Render::render($text, new RenderRules(60, TextUnit::Characters, true, 'X', links: true));

    $carrying = array_values(array_filter(
        $payload->segments,
        static fn ($segment): bool => str_contains($segment->text, 'example.test'),
    ));

    expect($carrying)->toHaveCount(1, 'the URL lives in exactly one segment')
        ->and($carrying[0]->text)->toContain($url);

    // And the byte range points at the whole URL, not a fragment of it.
    expect($carrying[0]->links)->toHaveCount(1)
        ->and(Text::sliceByteRange($carrying[0]->text, $carrying[0]->links[0]))->toBe($url);
});

it('computes link ranges PER SEGMENT rather than slicing the original', function () {
    $text = str_repeat('word ', 20).'https://example.test/x '.str_repeat('word ', 20);
    $payload = Render::render($text, new RenderRules(60, TextUnit::Characters, true, 'X', links: true));

    $carrying = array_values(array_filter(
        $payload->segments,
        static fn ($segment): bool => ($segment->links ?? []) !== [],
    ));

    expect($carrying)->toHaveCount(1);
    expect(Text::sliceByteRange($carrying[0]->text, $carrying[0]->links[0]))->toBe('https://example.test/x');
});

it('is pure — same input, same output, no clock', function () {
    $rules = new RenderRules(40, TextUnit::Characters, true, 'X');
    $text = 'A sentence. Another sentence. A third one here.';

    expect(Render::render($text, $rules))->toEqual(Render::render($text, $rules));
});

it('puts the renderer version INSIDE the payload hash', function () {
    $payload = Render::render('hello', new RenderRules(100, TextUnit::Characters, true, 'X'));

    $same = Render::payloadHash($payload);
    $bumped = Render::payloadHash($payload->withRendererVersion('render@2'));

    expect(Render::payloadHash($payload))->toBe($same, 'stable')
        ->and($bumped)->not->toBe($same, 'a version change invalidates an approval');
});

/**
 * The digest is a CROSS-RUNTIME contract, so it is pinned to a value computed by
 * actually running the TypeScript:
 *
 *     node --import tsx -e "import {render,payloadHash} from './src/render.ts';
 *       console.log(await payloadHash(render('hello',
 *         { limit: 100, unit: 'characters', thread: true, label: 'X' })))"
 *
 * A host may render on PHP and verify on Node, or the reverse. A difference here
 * would surface as an approval that refuses to dispatch for no visible reason,
 * which is the least debuggable failure this package could ship.
 */
it('agrees with the TypeScript payload hash, byte for byte', function () {
    $payload = Render::render('hello', new RenderRules(100, TextUnit::Characters, true, 'X'));

    expect(Render::payloadHash($payload))
        ->toBe('8f55c32b9617031d4a54187502b67559e272acd03e94d7a4d5ae98b85f06a39f');

    // And non-ASCII, where JSON escaping is the thing most likely to diverge:
    // JSON.stringify emits raw UTF-8 and leaves `/` alone, which is what
    // JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES reproduces.
    $unicode = Render::render(
        "Café \u{1F44D} https://example.test/a",
        new RenderRules(100, TextUnit::Graphemes, true, 'X'),
    );

    expect(Render::payloadHash($unicode))
        ->toBe('0b173296789ac00bfd8b41e4e7472ac326dbb68f27bbc070621720be59796856');

    expect(Render::payloadHash($payload->withRendererVersion('render@2')))
        ->toBe('a357710ea7c173859cb80e46d330d6e3eea3fec2c81ecdf8d051b89f0ca3e155');
});

it('recognises an empty payload, because the sha of nothing is a valid sha', function () {
    $rules = new RenderRules(10, TextUnit::Characters, true, 'X');

    expect(Render::isEmptyPayload(Render::render('   ', $rules)))->toBeTrue()
        ->and(Render::isEmptyPayload(Render::render('x', $rules)))->toBeFalse();
});

/* ── chaining ─────────────────────────────────────────────────────────────── */

it('fixes the root at the top and advances the parent', function () {
    $calls = [];
    $n = 0;

    $outcome = Chain::post(['one', 'two', 'three'], null, function (string $text, ?ChainLinks $links) use (&$calls, &$n): array {
        $calls[] = $links;
        $n++;

        return ['uri' => "at://post/{$n}", 'cid' => "cid{$n}"];
    });

    expect($outcome->posted)->toHaveCount(3)
        ->and($calls[0])->toBeNull('the first is top-level')
        ->and($calls[1]->root)->toBe(['uri' => 'at://post/1', 'cid' => 'cid1'])
        ->and($calls[1]->parent)->toBe(['uri' => 'at://post/1', 'cid' => 'cid1']);

    // Reverse these and every message attaches to the first: a fan, not a
    // thread — and the provider's response looks identical either way.
    expect($calls[2]->root)->toBe(['uri' => 'at://post/1', 'cid' => 'cid1'])
        ->and($calls[2]->parent)->toBe(['uri' => 'at://post/2', 'cid' => 'cid2']);
});

it('keeps THEIR root when answering somebody else', function () {
    $calls = [];
    $n = 0;
    $answering = new ChainLinks(
        ['uri' => 'at://theirs/1', 'cid' => 't1'],
        ['uri' => 'at://theirs/9', 'cid' => 't9'],
    );

    Chain::post(['a', 'b'], $answering, function (string $text, ?ChainLinks $links) use (&$calls, &$n): array {
        $calls[] = $links;
        $n++;

        return ['uri' => "at://post/{$n}", 'cid' => "cid{$n}"];
    });

    expect($calls[0]->root)->toBe($answering->root)
        ->and($calls[0]->parent)->toBe($answering->parent)
        ->and($calls[1]->root)->toBe($answering->root, 'their root, not ours')
        ->and($calls[1]->parent)->toBe(['uri' => 'at://post/1', 'cid' => 'cid1']);
});

it('stops at the first failure and reports what it posted', function () {
    $n = 0;

    $outcome = Chain::post(['a', 'b', 'c'], null, function () use (&$n): array {
        $n++;

        if ($n === 2) {
            throw new RuntimeException('boom');
        }

        return ['uri' => "at://post/{$n}", 'cid' => "cid{$n}"];
    });

    expect($outcome->posted)->toHaveCount(1, 'no hole is papered over')
        ->and($outcome->failedIndex)->toBe(1)
        ->and($outcome->ok())->toBeFalse()
        ->and($n)->toBe(2, 'it did not carry on past the failure');
});
