<?php

declare(strict_types=1);

use ParticleAcademy\Connectors\ConnectionHost;
use ParticleAcademy\Connectors\ConnectionSpec;
use ParticleAcademy\Connectors\ConnectorConfigException;
use ParticleAcademy\Connectors\ConnectorModeException;
use ParticleAcademy\Connectors\Mode;
use ParticleAcademy\Connectors\ModeResolver;
use ParticleAcademy\Connectors\SandboxKind;

/**
 * Resolving a connection — where a credential comes from, and which estate a
 * call reaches.
 *
 * The failure this whole area exists to prevent is a run that "succeeded"
 * because it quietly stopped talking to the provider: green, wrong, and
 * unreported.
 */

/* ── mode resolution ──────────────────────────────────────────────────────── */

it('lets an explicit ask beat the connection and the environment', function () {
    // The rule that makes the environment a default rather than a cage. An
    // environment that silently overrode a stated intention would produce a
    // workflow that reports success having charged nobody.
    expect(ModeResolver::resolve(Mode::Live, Mode::Sandbox, SandboxKind::Credential, true, false))
        ->toBe(Mode::Live)
        ->and(ModeResolver::resolve(Mode::Sandbox, Mode::Live, SandboxKind::Credential, true, true))
        ->toBe(Mode::Sandbox);
});

it('lets the connection beat the environment, and the environment decide last', function () {
    expect(ModeResolver::resolve(null, Mode::Sandbox, SandboxKind::Credential, true, true))->toBe(Mode::Sandbox)
        ->and(ModeResolver::resolve(null, null, SandboxKind::Credential, true, true))->toBe(Mode::Live)
        ->and(ModeResolver::resolve(null, null, SandboxKind::Credential, true, false))->toBe(Mode::Sandbox);
});

it('falls to fake locally when the sandbox exists but is not wired', function () {
    // What makes a freshly vendored connector runnable with no setup at all.
    expect(ModeResolver::resolve(null, null, SandboxKind::Credential, false, false))->toBe(Mode::Fake)
        ->and(ModeResolver::resolve(null, null, SandboxKind::None, false, false))->toBe(Mode::Fake);
});

it('refuses a sandbox the provider does not have', function () {
    expect(fn () => ModeResolver::resolve(Mode::Sandbox, null, SandboxKind::None, false, false))
        ->toThrow(ConnectorModeException::class);
});

it('reads auto and blank as "nobody said"', function () {
    expect(Mode::requested('auto'))->toBeNull()
        ->and(Mode::requested(''))->toBeNull()
        ->and(Mode::requested(null))->toBeNull()
        ->and(Mode::requested('live'))->toBe(Mode::Live);
});

/* ── the explicit-credentials path ────────────────────────────────────────── */

it('bypasses the registry entirely when credentials are handed in', function () {
    // A registry entry that would resolve to somebody else's account. Passing
    // credentials must not consult it at all.
    $host = new ConnectionHost(connections: [
        'stripe' => new ConnectionSpec(service: 'stripe', live: ['secretKey' => 'registry-key']),
    ]);

    $resolved = $host->resolve(
        service: 'stripe',
        operation: 'charge_create',
        sandbox: SandboxKind::Credential,
        requires: ['secretKey'],
        credentials: ['secretKey' => 'passed-in'],
    );

    expect($resolved->credentials['secretKey'])->toBe('passed-in')
        ->and($resolved->mode)->toBe(Mode::Live);
});

it('resolves auto to live when credentials are supplied', function () {
    // Supplying credentials IS the statement that a real call is intended.
    // Consulting an environment this resolver was told nothing about would be
    // inventing an answer.
    $resolved = (new ConnectionHost)->resolve(
        service: 'stripe',
        operation: 'charge_create',
        sandbox: SandboxKind::Credential,
        requires: ['secretKey'],
        credentials: ['secretKey' => 'k'],
    );

    expect($resolved->mode)->toBe(Mode::Live);
});

it('lets an explicit fake win even when credentials are supplied', function () {
    // Asking for the faker is a statement, and credentials in the same call do
    // not override it. Nothing secret is carried into the fake path.
    $resolved = (new ConnectionHost)->resolve(
        service: 'stripe',
        operation: 'charge_create',
        sandbox: SandboxKind::Credential,
        requires: ['secretKey'],
        credentials: ['secretKey' => 'k'],
        requested: Mode::Fake,
    );

    expect($resolved->mode)->toBe(Mode::Fake)
        ->and($resolved->credentials)->toBe([], 'no secret reaches the fake path');
});

it('honours an explicit sandbox on the supplied-credentials path', function () {
    $resolved = (new ConnectionHost)->resolve(
        service: 'stripe',
        operation: 'charge_create',
        sandbox: SandboxKind::BaseUrl,
        requires: ['secretKey'],
        baseUrls: ['sandbox' => 'https://sandbox.example.test'],
        credentials: ['secretKey' => 'k'],
        requested: Mode::Sandbox,
    );

    expect($resolved->mode)->toBe(Mode::Sandbox)
        ->and($resolved->baseUrl)->toBe('https://sandbox.example.test');
});

it('fails LOUDLY on an incomplete supplied credential set', function () {
    // Never a fallback to the registry. Quietly falling back to another source
    // is how the wrong account gets written to.
    $host = new ConnectionHost(connections: [
        'stripe' => new ConnectionSpec(service: 'stripe', live: ['secretKey' => 'registry-key']),
    ]);

    expect(fn () => $host->resolve(
        service: 'stripe',
        operation: 'charge_create',
        sandbox: SandboxKind::Credential,
        requires: ['secretKey'],
        credentials: ['wrongKey' => 'k'],
    ))->toThrow(ConnectorConfigException::class, 'was given credentials with no secretKey');
});

it('treats an EMPTY supplied credential set as supplied, not as absent', function () {
    // `[]` means "the caller supplied credentials and there are none", which is
    // a configuration mistake. `null` means "consult the registry". Collapsing
    // the two would silently use somebody else's key.
    $host = new ConnectionHost(connections: [
        'stripe' => new ConnectionSpec(service: 'stripe', live: ['secretKey' => 'registry-key']),
    ]);

    expect(fn () => $host->resolve(
        service: 'stripe',
        operation: 'charge_create',
        sandbox: SandboxKind::Credential,
        requires: ['secretKey'],
        credentials: [],
    ))->toThrow(ConnectorConfigException::class);
});

/* ── the registry path ────────────────────────────────────────────────────── */

it('resolves an unconfigured id to fake rather than throwing', function () {
    $resolved = (new ConnectionHost)->resolve(service: 'stripe', operation: 'charge_create');

    expect($resolved->mode)->toBe(Mode::Fake);
});

it('fails loudly when a remote mode was asked for and nothing is registered', function () {
    expect(fn () => (new ConnectionHost)->resolve(
        service: 'stripe',
        operation: 'charge_create',
        config: ['mode' => 'live'],
        sandbox: SandboxKind::Credential,
    ))->toThrow(ConnectorConfigException::class, 'no "stripe" connection is registered');
});

it('refuses a connection configured for another service', function () {
    $host = new ConnectionHost(connections: [
        'stripe' => new ConnectionSpec(service: 'paypal', live: ['secretKey' => 'k']),
    ]);

    expect(fn () => $host->resolve(
        service: 'stripe',
        operation: 'charge_create',
        sandbox: SandboxKind::Credential,
    ))->toThrow(ConnectorConfigException::class, 'is configured for the "paypal" service');
});

it('never degrades to the faker when a registered connection is missing a key', function () {
    $host = new ConnectionHost(
        production: true,
        connections: ['stripe' => new ConnectionSpec(service: 'stripe', live: [])],
    );

    expect(fn () => $host->resolve(
        service: 'stripe',
        operation: 'charge_create',
        sandbox: SandboxKind::Credential,
        requires: ['secretKey'],
    ))->toThrow(ConnectorConfigException::class, 'has no secretKey for live mode');
});
