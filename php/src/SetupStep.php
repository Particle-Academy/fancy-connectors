<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/** One step of standing a provider up. */
final readonly class SetupStep
{
    /**
     * @param  string  $detail  the step, AND the trap in it. A step with no trap named is
     *                          usually wrong — the traps are why setup takes an afternoon
     *                          rather than five minutes.
     */
    public function __construct(
        public string $title,
        public string $detail,
        public ?string $url = null,
    ) {}
}
