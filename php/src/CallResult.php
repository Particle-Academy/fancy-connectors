<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/**
 * The result of one call.
 *
 * `ref` is how the provider identifies what was done — the handle every later
 * question is joined on. **A 2xx with no ref is a failure**, and the connector
 * says so rather than reporting a success nobody can point at.
 */
final readonly class CallResult
{
    /**
     * @param  bool  $dryRun  true when nothing actually left the building
     * @param  Mode|null  $mode  which estate this ran against. Always reported, never
     *                           inferred by the caller: a reader who cannot tell a faked
     *                           result from a real one has been told nothing.
     */
    public function __construct(
        public bool $ok,
        public ?string $ref,
        public bool $dryRun,
        public string $detail,
        public ?Mode $mode = null,
    ) {}
}
