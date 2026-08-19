<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors\Tests;

use ParticleAcademy\Connectors\Clock;
use ParticleAcademy\Connectors\Mode;
use ParticleAcademy\Connectors\PreparedRequest;
use ParticleAcademy\Connectors\SandboxKind;
use ParticleAcademy\Connectors\ServiceDescriptor;
use ParticleAcademy\Connectors\Sleeper;
use ParticleAcademy\Connectors\Transport;
use ParticleAcademy\Connectors\TransportResponse;

/**
 * Test doubles.
 *
 * The sleeper is the important one: a suite that actually slept would be slow
 * enough that somebody would eventually shorten the delays to speed it up, and
 * then the thing under test would be the shortened version rather than the
 * shipped one.
 */
final class RecordingSleeper implements Sleeper
{
    /** @var list<int> */
    public array $waits = [];

    public function sleepMs(int $milliseconds): void
    {
        $this->waits[] = $milliseconds;
    }
}

/** A clock a test drives forward by hand, so the rate floor is deterministic. */
final class FrozenClock implements Clock
{
    public function __construct(public int $nowMs = 1_000_000) {}

    public function nowMs(): int
    {
        return $this->nowMs;
    }
}

/** A sleeper that advances a {@see FrozenClock} instead of waiting. */
final class ClockAdvancingSleeper implements Sleeper
{
    public function __construct(private readonly FrozenClock $clock) {}

    public function sleepMs(int $milliseconds): void
    {
        $this->clock->nowMs += $milliseconds;
    }
}

/** A transport driven by a closure, counting how many times it was reached. */
final class ScriptedTransport implements Transport
{
    public int $calls = 0;

    /** @param callable(int, PreparedRequest): TransportResponse $script */
    public function __construct(private $script) {}

    public function send(PreparedRequest $request): TransportResponse
    {
        $this->calls++;

        return ($this->script)($this->calls, $request);
    }
}

/** The minimum honest service descriptor, for tests that are not about services. */
function exampleService(?string $idempotencyHeader = null, array $requires = ['token']): ServiceDescriptor
{
    return new ServiceDescriptor(
        service: 'example',
        title: 'Example',
        sandbox: SandboxKind::None,
        baseUrls: [Mode::Live->value => 'https://api.example.test'],
        requires: $requires,
        authorize: static function (array $credentials, PreparedRequest $request, Mode $mode): void {
            $request->headers['Authorization'] = 'Bearer '.($credentials['token'] ?? '');
        },
        faker: static fn (): array => [],
        idempotencyHeader: $idempotencyHeader,
    );
}
