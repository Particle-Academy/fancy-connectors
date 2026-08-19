<?php

declare(strict_types=1);

use ParticleAcademy\Connectors\DeliveryMechanism;
use ParticleAcademy\Connectors\FakeValues;
use ParticleAcademy\Connectors\Mode;
use ParticleAcademy\Connectors\ResolvedConnection;
use ParticleAcademy\Connectors\TriggerEvent;
use ParticleAcademy\Connectors\WebhookVerifier;

/**
 * Verifying a delivery, and faking one — the two things that decide whether a
 * trigger is safe to mount and usable on day one.
 */
$stripeStyle = static fn (string $raw, ?string $timestamp): string => $timestamp.'.'.$raw;

it('refuses when no secret is configured', function () use ($stripeStyle) {
    // Never "accept when unconfigured". An endpoint that verifies nothing
    // because nobody set a secret is strictly worse than one that is off: it
    // LOOKS protected.
    expect(WebhookVerifier::verify('{}', 'sig', null, $stripeStyle))
        ->toBe(['ok' => false, 'reason' => 'no signing secret configured for this trigger']);

    expect(WebhookVerifier::verify('{}', 'sig', '', $stripeStyle)['ok'])->toBeFalse();
});

it('accepts a correctly signed delivery and rejects a tampered one', function () use ($stripeStyle) {
    $raw = '{"id":"evt_1"}';
    $timestamp = '1767225600';
    $signature = hash_hmac('sha256', $stripeStyle($raw, $timestamp), 'whsec', false);

    expect(WebhookVerifier::verify($raw, $signature, 'whsec', $stripeStyle, timestamp: $timestamp)['ok'])
        ->toBeTrue();

    // The RAW body matters: re-serialising parsed JSON changes whitespace and
    // key order, and the mismatch looks exactly like a wrong secret.
    expect(WebhookVerifier::verify('{"id": "evt_1"}', $signature, 'whsec', $stripeStyle, timestamp: $timestamp))
        ->toBe(['ok' => false, 'reason' => 'signature did not match']);
});

it('closes the replay window', function () use ($stripeStyle) {
    // Without a tolerance a valid signature is valid forever, so anyone who ever
    // saw a delivery can replay it whenever they like.
    $raw = '{"id":"evt_1"}';
    $timestamp = '1767225600';
    $signature = hash_hmac('sha256', $stripeStyle($raw, $timestamp), 'whsec', false);

    expect(WebhookVerifier::verify(
        $raw, $signature, 'whsec', $stripeStyle, tolerance: 300, timestamp: $timestamp, now: 1767225700,
    )['ok'])->toBeTrue();

    expect(WebhookVerifier::verify(
        $raw, $signature, 'whsec', $stripeStyle, tolerance: 300, timestamp: $timestamp, now: 1767299999,
    ))->toBe(['ok' => false, 'reason' => 'delivery is outside the 300s replay window']);
});

it('reads a header case-insensitively', function () {
    // Header case is not preserved consistently across proxies; a connector
    // reading the exact case would work behind one server and reject every
    // delivery behind another.
    $headers = ['STRIPE-Signature' => 't=1,v1=abc', 'content-type' => 'application/json'];

    expect(WebhookVerifier::header($headers, 'Stripe-Signature'))->toBe('t=1,v1=abc')
        ->and(WebhookVerifier::header($headers, 'stripe-signature'))->toBe('t=1,v1=abc')
        ->and(WebhookVerifier::header($headers, 'x-missing'))->toBeNull();
});

it('REFUSES a delivery for a trigger that declares no scheme', function () {
    // That asymmetry is the whole safety property: an unverifiable endpoint is a
    // stranger's button for starting workflows in your account.
    $result = TriggerEvent::verifyDelivery('example', 'thing_created', '{}', [], 'secret', null);

    expect($result['ok'])->toBeFalse()
        ->and($result['reason'])->toContain('declares no signature scheme');
});

/* ── triggers ─────────────────────────────────────────────────────────────── */

it('treats an EMPTY injected value as nothing delivered', function () {
    // A manually started run seeds an empty value, so a bare null check would
    // hand the executor an empty envelope and call it an event: every field
    // null, the run green, and nothing saying the trigger never fired.
    $event = TriggerEvent::resolve(
        service: 'example',
        operation: 'thing_created',
        delivery: DeliveryMechanism::Webhook,
        setup: 'Point the provider at /webhooks/example.',
        faker: static fn (string $op, array $config, FakeValues $fake): array => ['id' => $fake->id('evt')],
        connection: new ResolvedConnection('example', 'example', Mode::Fake),
        injected: [],
    );

    expect($event['id'])->toStartWith('evt_fake_');
});

it('fails loudly when a remote trigger was handed no event', function () {
    expect(fn () => TriggerEvent::resolve(
        service: 'example',
        operation: 'thing_created',
        delivery: DeliveryMechanism::Subscription,
        setup: 'Renew the subscription every 7 days.',
        faker: static fn (): array => [],
        connection: new ResolvedConnection('example', 'example', Mode::Live),
        injected: null,
    ))->toThrow(RuntimeException::class, 'no event was delivered to this trigger');
});

/* ── the faker ────────────────────────────────────────────────────────────── */

it('is deterministic — same inputs, same output', function () {
    $seed = FakeValues::seedForCall('stripe', 'charge_create', ['amount' => 500]);

    $first = new FakeValues($seed);
    $second = new FakeValues($seed);

    expect($first->id('ch'))->toBe($second->id('ch'))
        ->and($first->hex(8))->toBe($second->hex(8))
        ->and($first->int(1, 100))->toBe($second->int(1, 100));
});

it('does not let key ORDER change a seed', function () {
    // `json_encode` preserves insertion order, so without sorting, "same inputs,
    // same output" would hold only for arrays built in the same order — the kind
    // of almost-true that survives review and fails in a fixture months later.
    expect(FakeValues::seedForCall('stripe', 'charge_create', ['a' => 1, 'b' => 2]))
        ->toBe(FakeValues::seedForCall('stripe', 'charge_create', ['b' => 2, 'a' => 1]));
});

it('never reads the clock', function () {
    // A fixture asserting on `createdAt` must not start failing tomorrow.
    expect((new FakeValues(1))->timestamp())->toBe('2026-01-01T00:00:00.000Z')
        ->and((new FakeValues(1))->timestamp(90))->toBe('2026-01-01T00:01:30.000Z');
});

it('produces obviously fake values', function () {
    // Nobody should ever look at a faked result and wonder whether it moved real
    // money.
    expect((new FakeValues(FakeValues::seedForCall('stripe', 'charge_create', [])))->id('ch'))
        ->toStartWith('ch_fake_');
});
