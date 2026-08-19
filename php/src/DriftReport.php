<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/** What one drift check produced. */
final readonly class DriftReport
{
    /** @param list<DriftFinding> $findings */
    public function __construct(
        public string $connector,
        public string $checkedAt,
        public DriftOutcome $outcome,
        public array $findings,
        public DriftMethod $method,
    ) {}
}
