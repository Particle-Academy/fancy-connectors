<?php

declare(strict_types=1);

use ParticleAcademy\Connectors\ConnectorAmbiguousException;
use ParticleAcademy\Connectors\ConnectorClient;
use ParticleAcademy\Connectors\ConnectorException;
use ParticleAcademy\Connectors\ConnectorTransientException;
use ParticleAcademy\Connectors\ConnectorUnreachableException;
use ParticleAcademy\Connectors\Delivery;
use ParticleAcademy\Connectors\FailureKind;
use ParticleAcademy\Connectors\HttpErrors;
use ParticleAcademy\Connectors\Mode;
use ParticleAcademy\Connectors\RetryPolicy;
use ParticleAcademy\Connectors\Tests\ClockAdvancingSleeper;
use ParticleAcademy\Connectors\Tests\FrozenClock;
use ParticleAcademy\Connectors\Tests\RecordingSleeper;
use ParticleAcademy\Connectors\Tests\ScriptedTransport;
use ParticleAcademy\Connectors\TransportException;
use ParticleAcademy\Connectors\TransportResponse;

use function ParticleAcademy\Connectors\Tests\exampleService;

/**
 * The failure classification, and the one case the previous runtime got wrong.
 *
 * `retry-is-safe` is decided in exactly one place, so this is the file that
 * decides whether this package can ever produce a duplicate write.
 */
$idempotent = new RetryPolicy(attempts: 3, baseDelayMs: 100, maxDelayMs: 1000, idempotent: true);
$notIdempotent = new RetryPolicy(attempts: 3, baseDelayMs: 100, maxDelayMs: 1000, idempotent: false);

/* ── classification ───────────────────────────────────────────────────────── */

it('calls a request that never left unreachable', function () {
    // cURL's own numbering, which is the only error vocabulary PHP has.
    expect(Delivery::classifyCurlErrno(6))->toBe(FailureKind::Unreachable)   // could not resolve host
        ->and(Delivery::classifyCurlErrno(7))->toBe(FailureKind::Unreachable)  // could not connect
        ->and(Delivery::classifyCurlErrno(55))->toBe(FailureKind::Unreachable) // send error
        ->and(Delivery::classifyCurlErrno(56))->toBe(FailureKind::Unreachable); // recv error

    expect(Delivery::classifyError(TransportException::fromCurlErrno(7, 'connection refused'))->kind)
        ->toBe(FailureKind::Unreachable);
});

it('calls a timeout AMBIGUOUS, not transient', function () {
    // 28 is CURLE_OPERATION_TIMEDOUT. We stopped waiting; the provider may have
    // acted. Classifying it as unreachable is the double write this package
    // exists to prevent.
    expect(Delivery::classifyCurlErrno(28))->toBe(FailureKind::Ambiguous);

    expect(Delivery::classifyError(TransportException::fromCurlErrno(28, 'timed out'))->kind)
        ->toBe(FailureKind::Ambiguous);
});

it('falls an unrecognised error to ambiguous, never to safe', function () {
    // THE asymmetry. An unknown failure treated as unreachable would be
    // retried, and the one thing worse than a lost call is two calls nobody
    // asked for.
    expect(Delivery::classifyError(new RuntimeException('something odd'))->kind)->toBe(FailureKind::Ambiguous)
        ->and(Delivery::classifyError('a string')->kind)->toBe(FailureKind::Ambiguous)
        ->and(Delivery::classifyError(null)->kind)->toBe(FailureKind::Ambiguous)
        ->and(Delivery::classifyCurlErrno(9999)->name)->toBe('Ambiguous');

    // A cURL code nobody has mapped, from a future libcurl, is not unreachable.
    expect(Delivery::classifyError(TransportException::fromCurlErrno(77, 'a new failure'))->kind)
        ->toBe(FailureKind::Ambiguous);
});

it('treats 429 and 5xx as explicit refusals and other 4xx as real noes', function () {
    expect(Delivery::classifyStatus(429, 'slow down')->kind)->toBe(FailureKind::RefusedExplicitly)
        ->and(Delivery::classifyStatus(503, 'maintenance')->kind)->toBe(FailureKind::RefusedExplicitly)
        ->and(Delivery::classifyStatus(500, '')->kind)->toBe(FailureKind::RefusedExplicitly)
        ->and(Delivery::classifyStatus(401, 'bad token')->kind)->toBe(FailureKind::Rejected)
        ->and(Delivery::classifyStatus(422, 'too long')->kind)->toBe(FailureKind::Rejected)
        ->and(Delivery::classifyStatus(404, 'gone')->kind)->toBe(FailureKind::Rejected);
});

it('carries Retry-After through', function () {
    expect(Delivery::classifyStatus(429, '', '30')->retryAfter)->toBe(30)
        ->and(Delivery::classifyStatus(429, '', 'not-a-number')->retryAfter)->toBeNull()
        ->and(Delivery::classifyStatus(429, '')->retryAfter)->toBeNull();
});

it('retries ambiguity ONLY where the provider makes it safe', function () use ($idempotent, $notIdempotent) {
    expect(Delivery::shouldRetry(FailureKind::Ambiguous, $notIdempotent))->toBeFalse()
        ->and(Delivery::shouldRetry(FailureKind::Ambiguous, $idempotent))->toBeTrue()
        ->and(Delivery::shouldRetry(FailureKind::Unreachable, $notIdempotent))->toBeTrue()
        ->and(Delivery::shouldRetry(FailureKind::RefusedExplicitly, $notIdempotent))->toBeTrue()
        ->and(Delivery::shouldRetry(FailureKind::Rejected, $idempotent))->toBeFalse();
});

it('answers only the unconditional half in retryable()', function () {
    // The narrow question, deliberately: an old caller reading retryable()
    // becomes conservative rather than wrong.
    expect((new ConnectorAmbiguousException('x', 's', 'o'))->retryable())->toBeFalse()
        ->and((new ConnectorTransientException('x', 's', 'o'))->retryable())->toBeTrue()
        ->and((new ConnectorUnreachableException('x', 's', 'o'))->retryable())->toBeTrue()
        ->and(Delivery::isUnconditionallyRetryable(FailureKind::Ambiguous))->toBeFalse();
});

/* ── the retry ladder ─────────────────────────────────────────────────────── */

it('does not retry a timeout on a non-idempotent connector, and says go and look', function () use ($notIdempotent) {
    $calls = 0;

    $outcome = Delivery::deliver(
        function () use (&$calls): never {
            $calls++;

            throw TransportException::fromCurlErrno(28, 'timed out');
        },
        $notIdempotent,
        new RecordingSleeper,
    );

    expect($calls)->toBe(1, 'one attempt only')
        ->and($outcome->ok)->toBeFalse()
        ->and($outcome->kind)->toBe(FailureKind::Ambiguous)
        ->and($outcome->gaveUp)->toContain(substr(Delivery::AMBIGUOUS_REFUSAL, 0, 40));
});

it('DOES retry the same timeout on an idempotent connector', function () use ($idempotent) {
    $calls = 0;

    $outcome = Delivery::deliver(
        function () use (&$calls): string {
            $calls++;

            if ($calls === 1) {
                throw TransportException::fromCurlErrno(28, 'timed out');
            }

            return 'sent';
        },
        $idempotent,
        new RecordingSleeper,
    );

    expect($calls)->toBe(2)
        ->and($outcome->ok)->toBeTrue()
        ->and($outcome->value)->toBe('sent')
        ->and($outcome->attempts)->toHaveCount(1, 'the failed attempt stays on the record');
});

it('doubles the backoff then caps it, and lets Retry-After beat our own number', function () {
    $sleeper = new RecordingSleeper;

    Delivery::deliver(
        static fn (): never => throw TransportException::fromCurlErrno(7, 'connection refused'),
        new RetryPolicy(attempts: 4, baseDelayMs: 100, maxDelayMs: 250, idempotent: false),
        $sleeper,
    );

    expect($sleeper->waits)->toBe([100, 200, 250]);

    $second = new RecordingSleeper;

    Delivery::deliver(
        static fn (): never => throw HttpErrors::failure(429, 'slow down', '5'),
        new RetryPolicy(attempts: 2, baseDelayMs: 100, maxDelayMs: 1000, idempotent: false),
        $second,
    );

    // Ours is a guess; theirs is an instruction, and ignoring it is how a rate
    // limit becomes a ban.
    expect($second->waits)->toBe([5000], "the provider's number wins");
});

it('stops immediately on a real no, even on an idempotent connector', function () use ($idempotent) {
    $calls = 0;

    $outcome = Delivery::deliver(
        function () use (&$calls): never {
            $calls++;

            throw HttpErrors::failure(401, 'bad token');
        },
        $idempotent,
        new RecordingSleeper,
    );

    expect($calls)->toBe(1)
        ->and($outcome->gaveUp)->toContain('401');
});

/* ── the rate floor ───────────────────────────────────────────────────────── */

it('spaces calls on a channel and forgets an old one', function () {
    Delivery::resetRateState();

    $clock = new FrozenClock;
    $sleeper = new ClockAdvancingSleeper($clock);

    expect(Delivery::respectRate('z', 1000, $clock, $sleeper))->toBe(0)
        ->and(Delivery::respectRate('z', 1000, $clock, $sleeper))->toBe(1000);

    $clock->nowMs += 5000;

    expect(Delivery::respectRate('z', 1000, $clock, $sleeper))->toBe(0);

    Delivery::resetRateState();
});

/* ── the regression ───────────────────────────────────────────────────────── */

/**
 * REGRESSION — this is the test that fails against the previous runtime.
 *
 * `px-ui-sandbox/resources/flow-nodes/_connector/php/ConnectorClient.php`
 * caught `ConnectorTransientException` from the transport, whose `retryable()`
 * was hardcoded true, and retried it with `$retries = 2`. Its `CurlTransport`
 * threw exactly that exception for EVERY cURL failure — including a timeout.
 *
 * So a timeout on a connector with no idempotency key was attempted THREE
 * times: a silent double (or triple) write on the path whose entire job is not
 * producing one. Run against that code, `$transport->calls` below reads 3.
 */
it('makes ONE attempt on a timeout when idempotency is not declared', function () {
    $transport = new ScriptedTransport(
        static fn (): never => throw TransportException::fromCurlErrno(28, 'timed out'),
    );

    expect(fn () => (new ConnectorClient(sleeper: new RecordingSleeper))->call(
        service: exampleService(),
        operation: 'thing_create',
        request: ['method' => 'POST', 'path' => '/things'],
        credentials: ['token' => 't'],
        mode: Mode::Live,
        transport: $transport,
    ))->toThrow(ConnectorAmbiguousException::class);

    expect($transport->calls)->toBe(1, 'a timeout on a non-idempotent connector must not be repeated');
});

it('DOES retry the same timeout once the connector declares idempotency', function () {
    $transport = new ScriptedTransport(static function (int $call): TransportResponse {
        if ($call === 1) {
            throw TransportException::fromCurlErrno(28, 'timed out');
        }

        return new TransportResponse(200, [], '{"id":"1"}');
    });

    $result = (new ConnectorClient(sleeper: new RecordingSleeper))->call(
        service: exampleService(idempotencyHeader: 'Idempotency-Key'),
        operation: 'thing_create',
        request: ['method' => 'POST', 'path' => '/things'],
        idempotencyKey: 'run:step',
        idempotent: true,
        credentials: ['token' => 't'],
        mode: Mode::Live,
        transport: $transport,
    );

    expect($transport->calls)->toBe(2)
        ->and($result->data)->toBe(['id' => '1'])
        ->and($result->mode)->toBe(Mode::Live);
});

it('retries a 5xx without idempotency — the provider said it did nothing', function () {
    $transport = new ScriptedTransport(static fn (int $call): TransportResponse => $call === 1
        ? new TransportResponse(503, [], 'maintenance')
        : new TransportResponse(200, [], '{"ok":true}'));

    $result = (new ConnectorClient(sleeper: new RecordingSleeper))->call(
        service: exampleService(requires: []),
        operation: 'thing_create',
        request: ['method' => 'POST', 'path' => '/things'],
        credentials: ['token' => 't'],
        mode: Mode::Live,
        transport: $transport,
    );

    expect($transport->calls)->toBe(2)
        ->and($result->data)->toBe(['ok' => true])
        ->and($result->attempts)->toHaveCount(1);
});

it('never retries a 4xx that is not 429', function () {
    $transport = new ScriptedTransport(
        static fn (): TransportResponse => new TransportResponse(422, [], 'too long'),
    );

    expect(fn () => (new ConnectorClient(sleeper: new RecordingSleeper))->call(
        service: exampleService(requires: []),
        operation: 'thing_create',
        request: ['method' => 'POST', 'path' => '/things'],
        credentials: ['token' => 't'],
        mode: Mode::Live,
        transport: $transport,
    ))->toThrow(ConnectorException::class);

    expect($transport->calls)->toBe(1);
});

it('passes the idempotency key through as the provider header', function () {
    $seen = null;

    $transport = new ScriptedTransport(function (int $call, $request) use (&$seen): TransportResponse {
        $seen = $request->headers;

        return new TransportResponse(200, [], '{}');
    });

    (new ConnectorClient(sleeper: new RecordingSleeper))->call(
        service: exampleService(idempotencyHeader: 'Idempotency-Key'),
        operation: 'thing_create',
        request: ['method' => 'POST', 'path' => '/things'],
        idempotencyKey: 'run:step',
        idempotent: true,
        credentials: ['token' => 't'],
        mode: Mode::Live,
        transport: $transport,
    );

    expect($seen['Idempotency-Key'])->toBe('run:step')
        ->and($seen['Authorization'])->toBe('Bearer t');
});
