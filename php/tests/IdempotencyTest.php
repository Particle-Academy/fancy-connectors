<?php

declare(strict_types=1);

use ParticleAcademy\Connectors\ConnectorConfigException;
use ParticleAcademy\Connectors\ConnectorIdempotencyExpiredException;
use ParticleAcademy\Connectors\ForeignRunIdentity;
use ParticleAcademy\Connectors\Idempotency;
use ParticleAcademy\Connectors\RunIdentity;

/**
 * The idempotency key, and the structural bridge that lets a flow engine's own
 * identity satisfy this package with no import in either direction.
 */

/**
 * A stand-in for `FancyFlow\Runtime\RunIdentity` — same five members, same
 * signatures, and deliberately NOT implementing our interface, because the real
 * one does not either. If this passes, the real one does.
 */
final class ForeignIdentity
{
    /** @param list<string> $path */
    public function __construct(
        public readonly string $runKey,
        public readonly array $path = [],
        public readonly int $attempt = 1,
        public readonly string $firstAttemptAt = '2026-01-01T00:00:00.000Z',
    ) {}

    public function stepKey(string $nodeId, ?int $occurrence = null): string
    {
        $segments = $this->path;
        $segments[] = $occurrence === null ? $nodeId : $nodeId.'#'.$occurrence;

        return $this->runKey.':'.implode('/', $segments);
    }

    public function isReplaySafe(?int $windowSeconds, DateTimeInterface|string|null $now = null): bool
    {
        if ($this->attempt <= 1) {
            return true;
        }
        if ($windowSeconds === null) {
            return true;
        }
        if ($windowSeconds <= 0) {
            return false;
        }

        $nowTs = $now instanceof DateTimeInterface
            ? (float) $now->format('U.u')
            : (float) strtotime($now ?? 'now');

        return max(0.0, $nowTs - (float) strtotime($this->firstAttemptAt)) <= $windowSeconds;
    }
}

/** A context object, the way every flow engine in the suite carries one. */
final class ForeignContext
{
    public function __construct(public readonly ?object $run, public readonly array $inputs = []) {}
}

it('accepts a foreign identity that never heard of this package', function () {
    // PHP interfaces are nominal, so the real fancy-flow RunIdentity is not an
    // instance of ours. The adapter is the whole reason this works.
    $foreign = new ForeignIdentity('run-1');

    expect($foreign)->not->toBeInstanceOf(RunIdentity::class);

    $adapted = ForeignRunIdentity::adapt($foreign);

    expect($adapted)->toBeInstanceOf(RunIdentity::class)
        ->and($adapted->runKey)->toBe('run-1')
        ->and($adapted->attempt)->toBe(1)
        ->and($adapted->stepKey('charge'))->toBe('run-1:charge');
});

it('refuses an object that only half matches, rather than deriving a key from something else', function () {
    // A partial match produces a key that looks correct right up until two runs
    // collide on it, which is the failure the key exists to prevent.
    $half = new class
    {
        public string $runKey = 'run-1';
    };

    expect(fn () => ForeignRunIdentity::adapt($half))
        ->toThrow(ConnectorConfigException::class, 'has no `attempt`');
});

it('finds the identity on a context object', function () {
    $ctx = new ForeignContext(new ForeignIdentity('run-9'));

    expect(Idempotency::identity($ctx)?->runKey)->toBe('run-9')
        ->and(Idempotency::keyFor($ctx, 'charge'))->toBe('run-9:charge');
});

it('produces the SAME key on a retry of one step', function () {
    // The entire point. A key that changed per attempt would create a second
    // charge on every retry.
    $first = Idempotency::keyFor(new ForeignIdentity('run-1', attempt: 1), 'charge');
    $second = Idempotency::keyFor(
        new ForeignIdentity('run-1', attempt: 2, firstAttemptAt: gmdate('Y-m-d\TH:i:s\Z')),
        'charge',
    );

    expect($second)->toBe($first);
});

it('produces DIFFERENT keys for different runs and different occurrences', function () {
    expect(Idempotency::keyFor(new ForeignIdentity('run-1'), 'charge'))
        ->not->toBe(Idempotency::keyFor(new ForeignIdentity('run-2'), 'charge'));

    expect(Idempotency::keyFor(new ForeignIdentity('run-1'), 'charge', occurrence: 0))
        ->not->toBe(Idempotency::keyFor(new ForeignIdentity('run-1'), 'charge', occurrence: 1));

    // Occurrence 0 is a REAL occurrence. A truthiness check would collapse
    // iteration 0 into the un-iterated key.
    expect(Idempotency::keyFor(new ForeignIdentity('run-1'), 'charge', occurrence: 0))
        ->not->toBe(Idempotency::keyFor(new ForeignIdentity('run-1'), 'charge'));
});

it('sends no key at all when no host published an identity', function () {
    // Null, not an invented value. A fresh random value is unique per ATTEMPT,
    // so a retry would create a second charge.
    expect(Idempotency::keyFor(null, 'charge'))->toBeNull()
        ->and(Idempotency::keyFor(new ForeignContext(null), 'charge'))->toBeNull();
});

it('accepts a seeded run key from a host with no engine support', function () {
    $key = Idempotency::keyFor(null, 'charge', seededInputs: ['__runKey' => 'seeded-run']);

    expect($key)->toBe('seeded-run:charge');
});

it('never refuses a FIRST attempt, however long the run was parked', function () {
    // Nothing was sent on an earlier attempt, so there is nothing for the
    // provider to have forgotten. This is what lets an approval sit for a week
    // and then charge.
    $stale = new ForeignIdentity('run-1', attempt: 1, firstAttemptAt: '2020-01-01T00:00:00.000Z');

    expect(Idempotency::keyFor($stale, 'charge'))->toBe('run-1:charge');
});

it('THROWS on a retry outside the provider window rather than choosing', function () {
    // Resending the key writes twice because the provider forgot it; sending a
    // fresh one writes twice by construction. There is no safe third option, so
    // a loud stuck run beats a silent double write.
    $expired = new ForeignIdentity('run-1', attempt: 2, firstAttemptAt: '2020-01-01T00:00:00.000Z');

    expect(fn () => Idempotency::keyFor($expired, 'charge'))
        ->toThrow(ConnectorIdempotencyExpiredException::class, 'outside the provider');
});

it('reads a zero window as "does not dedupe", not as "dedupes forever"', function () {
    $retry = new ForeignIdentity('run-1', attempt: 2, firstAttemptAt: gmdate('Y-m-d\TH:i:s\Z'));

    expect(fn () => Idempotency::keyFor($retry, 'charge', windowSeconds: 0))
        ->toThrow(ConnectorIdempotencyExpiredException::class);

    // Null means the provider never forgets, which is the opposite answer.
    expect(Idempotency::keyFor($retry, 'charge', windowSeconds: null))->toBe('run-1:charge');
});

it('shortens an over-long key deterministically, keeping the prefix greppable', function () {
    $long = new ForeignIdentity('run-1', path: [str_repeat('deep-subflow-node-id/', 40)]);

    $key = Idempotency::keyFor($long, 'charge');

    expect(strlen($key))->toBe(Idempotency::MAX_KEY_LENGTH)
        ->and($key)->toStartWith('run-1:deep-subflow-node-id')
        ->and($key)->toBe(Idempotency::keyFor($long, 'charge'), 'and it is stable');
});
